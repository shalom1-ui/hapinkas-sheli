// reports.js — דיווחי אנשי מקצוע (ריפוי בעיסוק / טיפול רגשי / אחר) על תלמיד,
// אשר נכנסים אוטומטית לתיק המאוחד של אותו תלמיד (ר' students.js -> /file), ומעדכנים גם
// את ההורים המשויכים במייל (ר' services/email.js).
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");
const { sendEmail } = require("../services/email");
const { isOwnerOrProfessional } = require("../lib/access");
const { rememberPhrase, getDictionary } = require("../lib/dictionary");

// אלה הן קטגוריות מוצעות בתפריט הנפתח, לנוחות ולסטטיסטיקה - אבל role_type בפועל יכול
// להיות כל טקסט חופשי אחר (למשל כשבוחרים "אחר" ומקלידים סוג טיפול שלא ברשימה), בדיוק כמו trend.
const VALID_ROLE_TYPES = [
  "ריפוי בעיסוק",
  "טיפול רגשי",
  "תרפיה במוסיקה",
  "תרפיה באומנות",
  "תרפיה בחיות",
  "אחר",
];
const VALID_TRENDS = ["משתפרת", "יציבה", "דורשת תשומת לב"];

// שולח בפועל את מיילי העדכון להורים המשויכים לתלמיד, על דוח נתון.
// מנותק בכוונה מהלוגיקה של "מתי לשלוח" (ר' שימוש למטה) כדי שאפשר יהיה גם לשלוח מאוחר יותר ידנית.
async function notifyGuardiansOfReport(student, report) {
  const guardians = db
    .prepare(
      `SELECT u.email, u.full_name FROM student_guardians sg
       JOIN users u ON u.id = sg.guardian_user_id
       WHERE sg.student_id = ?`
    )
    .all(student.id);

  const notified_guardians = [];
  for (const guardian of guardians) {
    if (!guardian.email) {
      notified_guardians.push({ guardian: guardian.full_name, ok: false, error: "לא רשומה כתובת מייל להורה" });
      continue;
    }
    try {
      const result = await sendEmail({
        to: guardian.email,
        subject: `עדכון התקדמות עבור ${student.name}`,
        body:
          `שלום ${guardian.full_name},\n\n` +
          `התקבל דיווח (${report.role_type}) עבור ${student.name}:\n"${report.note}"\n\n` +
          `בברכה,\nהפנקס שלי`,
      });
      notified_guardians.push({ guardian: guardian.full_name, email: guardian.email, ...result });
    } catch (e) {
      notified_guardians.push({ guardian: guardian.full_name, email: guardian.email, ok: false, error: e.message });
    }
  }
  return notified_guardians;
}

function register(router) {
  // הוספת דוח טיפולי לתלמיד — משמש גם ידנית מהאזור האישי וגם דרך המנוע הקולי (עם transcript)
  router.post("/api/students/:id/reports", requireAuth(async (ctx) => {
    const student = db.prepare("SELECT * FROM students WHERE id = ?").get(ctx.params.id);
    if (!student) return json(ctx.res, 404, { error: "תלמיד לא נמצא" });

    const { role_type, note, trend, transcript, notify_guardians } = ctx.body;
    // סוג הדיווח (role_type) יכול להיות אחת הקטגוריות המוצעות, או כל ניסוח חופשי אחר
    // (למשל כשבוחרים "אחר" ומקלידים סוג טיפול שלא נמצא ברשימה) - באותו עיקרון כמו trend למטה.
    const finalRoleType = typeof role_type === "string" ? role_type.trim() : "";
    if (!finalRoleType) {
      return json(ctx.res, 400, { error: `יש להזין סוג דיווח. אפשרויות מוצעות: ${VALID_ROLE_TYPES.join(", ")} - או ניסוח חופשי משלכם` });
    }
    if (!note) return json(ctx.res, 400, { error: "יש להזין תוכן דיווח" });

    // המגמה (trend) יכולה להיות אחת משלוש האפשרויות הקבועות, או כל טקסט חופשי אחר
    // (למשל כשבוחרים "אחר" ומקלידים ניסוח מותאם-אישית). רק "משתפרת" בדיוק מפעילה
    // ברירת מחדל של שליחת מייל אוטומטית להורים (ר' wantsNotifyNow למטה).
    const finalTrend = typeof trend === "string" && trend.trim() ? trend.trim() : "יציבה";

    const info = db
      .prepare(
        "INSERT INTO therapy_reports (student_id, professional_user_id, role_type, note, trend, transcript) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(student.id, ctx.user.userId, finalRoleType, note, finalTrend, transcript || null);

    const report = db.prepare("SELECT * FROM therapy_reports WHERE id = ?").get(info.lastInsertRowid);

    // "מילון" ניסוחים: שומרים את תוכן הדיווח, ואת המגמה/סוג הדיווח אם הם ניסוח מותאם-אישית
    // (לא אחת מהקטגוריות הקבועות) - כדי שיוצעו כהשלמה אוטומטית לתלמידים הבאים.
    rememberPhrase(ctx.user.userId, "note", note);
    if (!VALID_TRENDS.includes(finalTrend)) rememberPhrase(ctx.user.userId, "trend", finalTrend);
    if (!VALID_ROLE_TYPES.includes(finalRoleType)) rememberPhrase(ctx.user.userId, "role_type", finalRoleType);

    // שמירה ושליחה הן שתי פעולות נפרדות: הדוח תמיד נשמר בתיק המאוחד.
    // האם לשלוח מייל להורים *עכשיו* נקבע לפי notify_guardians אם נשלח מפורשות בבקשה,
    // ואם לא נשלח - ברירת המחדל היא לשלוח רק כשיש שיפור (trend === "משתפרת"), כמו קודם.
    // אפשר גם לשלוח מאוחר יותר, בנפרד, דרך POST /api/reports/:id/notify.
    const wantsNotifyNow =
      typeof notify_guardians === "boolean" ? notify_guardians : finalTrend === "משתפרת";

    const notified_guardians = wantsNotifyNow ? await notifyGuardiansOfReport(student, report) : [];

    return json(ctx.res, 201, { report, notified_guardians });
  }));

  // "מילון" ניסוחים קודמים של המשתמש המחובר (לתוכן דיווח, מגמה/סוג-דיווח מותאמים-אישית,
  // או דיווח מעקב על מפגש חונכות - ר' students.js) - לשימוש כהשלמה אוטומטית בטופס, בלי להקליד מחדש כל פעם.
  router.get("/api/reports/dictionary", requireAuth(async (ctx) => {
    const kind = ["trend", "role_type", "session_note"].includes(ctx.query.kind) ? ctx.query.kind : "note";
    return json(ctx.res, 200, { phrases: getDictionary(ctx.user.userId, kind) });
  }));

  // שליחת עדכון להורים על דוח שכבר נשמר בעבר (למקרה שבזמן השמירה נבחר "שמור בלבד, לשלוח מאוחר יותר").
  // מותר רק לאיש המקצוע שכתב את הדוח, או לבעלים/איש מקצוע אחר על אותו תלמיד.
  router.post("/api/reports/:id/notify", requireAuth(async (ctx) => {
    const report = db.prepare("SELECT * FROM therapy_reports WHERE id = ?").get(ctx.params.id);
    if (!report) return json(ctx.res, 404, { error: "דוח לא נמצא" });
    const student = db.prepare("SELECT * FROM students WHERE id = ?").get(report.student_id);
    if (!student) return json(ctx.res, 404, { error: "תלמיד לא נמצא" });

    const isAuthor = report.professional_user_id === ctx.user.userId;
    if (!isAuthor && !isOwnerOrProfessional(student, ctx.user.userId)) {
      return json(ctx.res, 403, { error: "אין הרשאה לשלוח עדכון על דוח זה" });
    }

    const notified_guardians = await notifyGuardiansOfReport(student, report);
    return json(ctx.res, 200, { notified_guardians });
  }));

  // רשימת כל הדוחות שכתב איש המקצוע המחובר (למסך "מעגל מטפלים" שלו)
  router.get("/api/reports/mine", requireAuth(async (ctx) => {
    const rows = db
      .prepare(
        `SELECT tr.*, s.name AS student_name FROM therapy_reports tr
         JOIN students s ON s.id = tr.student_id
         WHERE tr.professional_user_id = ? ORDER BY tr.occurred_at DESC`
      )
      .all(ctx.user.userId);
    return json(ctx.res, 200, { reports: rows });
  }));

  // מחיקת דוח (תיקון טעות הזנה)
  router.delete("/api/reports/:id", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM therapy_reports WHERE id = ? AND professional_user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "דוח לא נמצא" });
    db.prepare("DELETE FROM therapy_reports WHERE id = ?").run(row.id);
    return json(ctx.res, 200, { message: "הדוח נמחק" });
  }));
}

module.exports = { register };
