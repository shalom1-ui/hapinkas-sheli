// students.js — חונכות: ניהול תלמידים, צ'ק-אין/צ'ק-אאוט, מפגש מהיר (זמן קבוע מראש),
// והתיק המאוחד של כל תלמיד (מפגשי חונכות + דוחות טיפוליים + הערות/צ'אט פנימי בציר זמן אחד).
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");
const { isGuardian, isOwnerOrProfessional } = require("../lib/access");
const { rememberPhrase } = require("../lib/dictionary");
const { moveToTrash } = require("../lib/trash");

function register(router) {
  // רשימת תלמידים של המשתמש המחובר
  router.get("/api/students", requireAuth(async (ctx) => {
    const rows = db
      .prepare("SELECT * FROM students WHERE owner_user_id = ? AND active = 1 ORDER BY name")
      .all(ctx.user.userId);
    return json(ctx.res, 200, { students: rows });
  }));

  // הוספת תלמיד
  router.post("/api/students", requireAuth(async (ctx) => {
    const { name, contact_info } = ctx.body;
    if (!name) return json(ctx.res, 400, { error: "יש להזין שם תלמיד" });
    const info = db
      .prepare("INSERT INTO students (owner_user_id, name, contact_info) VALUES (?, ?, ?)")
      .run(ctx.user.userId, name, contact_info || null);
    const row = db.prepare("SELECT * FROM students WHERE id = ?").get(info.lastInsertRowid);
    return json(ctx.res, 201, { student: row });
  }));

  // הסרת תלמיד (למשל אם הפסיק ללמוד) - מחיקה "רכה" בלבד (active=0): לא נמחקת ההיסטוריה (מפגשים,
  // דוחות, הערות, מסמכים) - התלמיד רק מפסיק להופיע ברשימה הפעילה. אותה פעולה זמינה גם בטלפון
  // (ר' routes/ivr.js, mentor_remove_confirm).
  router.delete("/api/students/:id", requireAuth(async (ctx) => {
    const student = getOwnedStudent(ctx.params.id, ctx.user.userId);
    if (!student) return json(ctx.res, 404, { error: "תלמיד לא נמצא" });
    db.prepare("UPDATE students SET active = 0 WHERE id = ?").run(student.id);
    // "סל מחזור" - התלמיד עצמו כבר לא נמחק בפועל (active=0 בלבד, ר' הערה למעלה) - רק מסומן שם, כדי
    // שיופיע יחד עם שאר הפריטים המחוקים ב"סל מחזור" (ר' routes/trash.js - entity_type='student'
    // משוחזר ע"י active=1 בחזרה, לא INSERT כמו שאר הסוגים - השורה עצמה מעולם לא נעלמה).
    moveToTrash(ctx.user.userId, "student", "students", `תלמיד: ${student.name}`, { id: student.id });
    return json(ctx.res, 200, { ok: true });
  }));

  // ---------- שיטה 1: צ'ק-אין / צ'ק-אאוט עם חישוב משך אוטומטי ----------
  router.post("/api/students/:id/checkin", requireAuth(async (ctx) => {
    const student = getOwnedStudent(ctx.params.id, ctx.user.userId);
    if (!student) return json(ctx.res, 404, { error: "תלמיד לא נמצא" });
    if (student.checkin_at) return json(ctx.res, 409, { error: "כבר קיים מפגש פתוח לתלמיד זה" });

    db.prepare("UPDATE students SET checkin_at = datetime('now') WHERE id = ?").run(student.id);
    return json(ctx.res, 200, { message: `נרשם צ'ק-אין עבור ${student.name}`, checkin_at: new Date().toISOString() });
  }));

  router.post("/api/students/:id/checkout", requireAuth(async (ctx) => {
    const student = getOwnedStudent(ctx.params.id, ctx.user.userId);
    if (!student) return json(ctx.res, 404, { error: "תלמיד לא נמצא" });
    if (!student.checkin_at) return json(ctx.res, 409, { error: "אין מפגש פתוח לתלמיד זה" });

    const start = new Date(student.checkin_at + "Z"); // SQLite datetime('now') הוא UTC
    const durationMinutes = Math.max(1, Math.round((Date.now() - start.getTime()) / 60000));
    const note = typeof ctx.body.note === "string" && ctx.body.note.trim() ? ctx.body.note.trim() : null;

    const sessionInfo = db
      .prepare("INSERT INTO sessions (student_id, mentor_user_id, method, duration_minutes, note) VALUES (?, ?, 'checkin_checkout', ?, ?)")
      .run(student.id, ctx.user.userId, durationMinutes, note);
    db.prepare("UPDATE students SET checkin_at = NULL WHERE id = ?").run(student.id);
    // דיווח המעקב החופשי (אם היה כזה) נכנס גם ל"מילון" האישי של החונך, להצעה אוטומטית בפעם הבאה
    if (note) rememberPhrase(ctx.user.userId, "session_note", note);

    return json(ctx.res, 200, {
      message: `נרשם צ'ק-אאוט עבור ${student.name} — משך המפגש: ${durationMinutes} דקות`,
      session: db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionInfo.lastInsertRowid),
    });
  }));

  // ---------- שיטה 2: מפגש מהיר לפי משך ברירת מחדל שהחונך הגדיר לעצמו ----------
  router.post("/api/students/:id/quick-session", requireAuth(async (ctx) => {
    const student = getOwnedStudent(ctx.params.id, ctx.user.userId);
    if (!student) return json(ctx.res, 404, { error: "תלמיד לא נמצא" });

    const user = db.prepare("SELECT default_session_minutes FROM users WHERE id = ?").get(ctx.user.userId);
    const minutes = Number(ctx.body.duration_minutes) || user.default_session_minutes || 45;
    const note = typeof ctx.body.note === "string" && ctx.body.note.trim() ? ctx.body.note.trim() : null;

    const sessionInfo = db
      .prepare("INSERT INTO sessions (student_id, mentor_user_id, method, duration_minutes, note) VALUES (?, ?, 'quick_preset', ?, ?)")
      .run(student.id, ctx.user.userId, minutes, note);
    if (note) rememberPhrase(ctx.user.userId, "session_note", note);

    return json(ctx.res, 201, {
      message: `נרשם מפגש עבור ${student.name} (${minutes} דקות)`,
      session: db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionInfo.lastInsertRowid),
    });
  }));

  // ---------- התיק המאוחד: מפגשים + דוחות טיפוליים + הערות, ממויין לציר זמן אחד ----------
  // גישה: בעלים (חונך שיצר את התלמיד), או כל משתמש עם תפקיד מקצועי (mentor/therapist/supervisor).
  // הורים (guardians) לא מקבלים גישה לנתיב הזה בכוונה - הצ'אט הפנימי בין הצוות המקצועי אינו מיועד להם,
  // הם רואים רק את /summary למטה.
  router.get("/api/students/:id/file", requireAuth(async (ctx) => {
    const student = db.prepare("SELECT * FROM students WHERE id = ?").get(ctx.params.id);
    if (!student) return json(ctx.res, 404, { error: "תלמיד לא נמצא" });
    if (!isOwnerOrProfessional(student, ctx.user.userId)) {
      return json(ctx.res, 403, { error: "אין הרשאה לצפות בתיק המלא. הורים יכולים לצפות בסיכום בנתיב /summary" });
    }

    const sessions = db.prepare("SELECT * FROM sessions WHERE student_id = ? ORDER BY occurred_at DESC").all(student.id);
    const reports = db.prepare("SELECT * FROM therapy_reports WHERE student_id = ? ORDER BY occurred_at DESC").all(student.id);
    const comments = db.prepare("SELECT * FROM student_comments WHERE student_id = ? ORDER BY occurred_at DESC").all(student.id);
    const lessonReports = db.prepare("SELECT * FROM lesson_reports WHERE student_id = ? ORDER BY occurred_at DESC").all(student.id);
    const documents = db
      .prepare("SELECT id, title, filename, mime_type, size_bytes, uploaded_at FROM documents WHERE student_id = ? ORDER BY uploaded_at DESC")
      .all(student.id);

    const timeline = [
      ...sessions.map(s => ({ kind: "session", occurred_at: s.occurred_at, data: s })),
      ...reports.map(r => ({ kind: "report", occurred_at: r.occurred_at, data: r })),
      ...comments.map(c => ({ kind: "comment", occurred_at: c.occurred_at, data: c })),
      ...lessonReports.map(l => ({ kind: "lesson_report", occurred_at: l.occurred_at, data: l })),
      ...documents.map(d => ({ kind: "document", occurred_at: d.uploaded_at, data: d })), // רק כותרת/מטא-דאטה - להורדת התוכן יש נתיב נפרד
    ].sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));

    return json(ctx.res, 200, { student, timeline });
  }));

  // הוספת הערה/תגובה לתיק התלמיד (משמש גם למפקחים שמגיבים על דוחות — "צ'אט פנימי")
  // אותה מגבלת הרשאה כמו /file - הורים לא יכולים לכתוב לצ'אט הפנימי.
  router.post("/api/students/:id/comments", requireAuth(async (ctx) => {
    const student = db.prepare("SELECT * FROM students WHERE id = ?").get(ctx.params.id);
    if (!student) return json(ctx.res, 404, { error: "תלמיד לא נמצא" });
    if (!isOwnerOrProfessional(student, ctx.user.userId)) {
      return json(ctx.res, 403, { error: "אין הרשאה להוסיף הערה לצ'אט הפנימי" });
    }
    const { text, author_label } = ctx.body;
    if (!text) return json(ctx.res, 400, { error: "יש להזין תוכן להערה" });

    const user = db.prepare("SELECT full_name FROM users WHERE id = ?").get(ctx.user.userId);
    const info = db
      .prepare("INSERT INTO student_comments (student_id, author_user_id, author_label, text) VALUES (?, ?, ?, ?)")
      .run(student.id, ctx.user.userId, author_label || user.full_name, text);

    return json(ctx.res, 201, { comment: db.prepare("SELECT * FROM student_comments WHERE id = ?").get(info.lastInsertRowid) });
  }));

  // ---------- הורים ----------
  // כל איש צוות מקצועי (בעלים/חונך/מטפל/מפקח - לא רק הבעלים המקורי) יכול לשייך הורה לתלמיד -
  // אותה הרשאה בדיוק כמו /file ו-/comments. הורים עצמם (roles='private' בלבד, בלי תפקיד מקצועי)
  // לא עוברים את הבדיקה הזו, ולכן לא יכולים "להצהיר" על עצמם כהורה של תלמיד זר.
  router.post("/api/students/:id/guardians", requireAuth(async (ctx) => {
    const student = db.prepare("SELECT * FROM students WHERE id = ?").get(ctx.params.id);
    if (!student) return json(ctx.res, 404, { error: "תלמיד לא נמצא" });
    if (!isOwnerOrProfessional(student, ctx.user.userId)) {
      return json(ctx.res, 403, { error: "אין הרשאה לשייך הורה לתלמיד זה" });
    }

    const { username } = ctx.body;
    if (!username) return json(ctx.res, 400, { error: "יש להזין שם משתמש של ההורה" });
    const guardianUser = db.prepare("SELECT id, full_name FROM users WHERE username = ?").get(username);
    if (!guardianUser) return json(ctx.res, 404, { error: "לא נמצא משתמש עם שם המשתמש הזה. ההורה צריך קודם להירשם למערכת" });

    try {
      db.prepare("INSERT INTO student_guardians (student_id, guardian_user_id) VALUES (?, ?)").run(student.id, guardianUser.id);
    } catch (e) {
      return json(ctx.res, 409, { error: "ההורה כבר משויך לתלמיד הזה" });
    }
    return json(ctx.res, 201, { message: `${guardianUser.full_name} שויך/ה כהורה של ${student.name}` });
  }));

  // רשימת הילדים ששיוכתי אליהם כהורה
  router.get("/api/my-children", requireAuth(async (ctx) => {
    const rows = db
      .prepare(
        `SELECT s.id, s.name FROM student_guardians sg
         JOIN students s ON s.id = sg.student_id
         WHERE sg.guardian_user_id = ? AND s.active = 1 ORDER BY s.name`
      )
      .all(ctx.user.userId);
    return json(ctx.res, 200, { children: rows });
  }));

  // סיכום ידידותי להורה: מפגשי חונכות ודוחות התקדמות בלבד - בלי הצ'אט הפנימי בין הצוות המקצועי.
  // גישה: בעלים, או הורה משויך (לא כל משתמש מחובר, כדי שהורה לא יוכל לצפות בסיכום של ילד שאינו שלו).
  router.get("/api/students/:id/summary", requireAuth(async (ctx) => {
    const student = db.prepare("SELECT * FROM students WHERE id = ?").get(ctx.params.id);
    if (!student) return json(ctx.res, 404, { error: "תלמיד לא נמצא" });
    const owner = student.owner_user_id === ctx.user.userId;
    const guardian = isGuardian(student.id, ctx.user.userId);
    if (!owner && !guardian) {
      return json(ctx.res, 403, { error: "אין הרשאה לצפות בסיכום של תלמיד זה" });
    }

    const sessions = db
      .prepare("SELECT occurred_at, duration_minutes, note FROM sessions WHERE student_id = ? ORDER BY occurred_at DESC")
      .all(student.id);
    const reports = db
      .prepare("SELECT role_type, trend, note, occurred_at FROM therapy_reports WHERE student_id = ? ORDER BY occurred_at DESC")
      .all(student.id);
    // טופסי "הכנה לשיעור" - בכוונה בלי teacher_phone/convenient_hours (פרטי קשר של החונך, לא מיועדים לתצוגת הורה)
    const lessonReports = db
      .prepare(
        `SELECT lesson_date, week_number, meeting_number, study_duration_minutes, topic_studied, goal,
                work_method, practical_application, connection_cooperation, coping_achieving_goals,
                environment_comments, lateness, absences, occurred_at
         FROM lesson_reports WHERE student_id = ? ORDER BY occurred_at DESC`
      )
      .all(student.id);

    return json(ctx.res, 200, {
      student: { id: student.id, name: student.name },
      sessions_count: sessions.length,
      total_minutes: sessions.reduce((sum, s) => sum + s.duration_minutes, 0),
      recent_sessions: sessions.slice(0, 10),
      reports, // דוחות התקדמות מקצועיים - בכוונה כן מוצגים להורה, זה בדיוק ה"סיכום" שהוא צריך לראות
      lesson_reports: lessonReports, // טופסי "הכנה לשיעור" - גם הם חלק מהסיכום שההורה רואה
      // שימו לב: מסמכים שהועלו (documents) לא נכללים כאן בכוונה - נחשבים תוכן פנימי, כמו הצ'אט הפנימי
    });
  }));
}

function getOwnedStudent(id, userId) {
  return db.prepare("SELECT * FROM students WHERE id = ? AND owner_user_id = ?").get(id, userId);
}

module.exports = { register };
