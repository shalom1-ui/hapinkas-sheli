// lessonReports.js — "הכנה לשיעור": דיגיטציה של טופס חונכות נייר (הועבר ע"י המשתמש), בנוסף למפגש
// הרגיל (checkin/checkout/quick-session, ר' students.js). כל השדות אופציונליים וחופשיים בניסוח.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");
const { isOwnerOrProfessional } = require("../lib/access");
const { rememberPhrase, getDictionary } = require("../lib/dictionary");

// שדות טקסט חופשי שכדאי לזכור ב"מילון" האישי של החונך, להצעה אוטומטית לתלמידים הבאים.
// kind ב-phrase_dictionary לכל שדה הוא "lesson_" + שם השדה (ר' גם /api/reports/dictionary).
const DICTIONARY_FIELDS = [
  "convenient_hours", "study_days", "guidance_date", "reassessment_recommendation", "reassessment_date",
  "topic_studied", "goal", "work_method", "practical_application",
  "connection_cooperation", "coping_achieving_goals", "environment_comments", "lateness", "absences",
];

function toIntOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" && v !== null && v !== undefined ? Math.trunc(n) : null;
}

function register(router) {
  router.post("/api/students/:id/lesson-reports", requireAuth(async (ctx) => {
    const student = db.prepare("SELECT * FROM students WHERE id = ?").get(ctx.params.id);
    if (!student) return json(ctx.res, 404, { error: "תלמיד לא נמצא" });
    if (!isOwnerOrProfessional(student, ctx.user.userId)) {
      return json(ctx.res, 403, { error: "אין הרשאה להוסיף טופס הכנה לשיעור לתלמיד זה" });
    }

    const b = ctx.body;
    const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

    const info = db
      .prepare(
        `INSERT INTO lesson_reports (
           student_id, mentor_user_id, lesson_date, teacher_name, teacher_phone, convenient_hours,
           study_days, guidance_date, reassessment_recommendation, reassessment_date,
           week_number, meeting_number, study_duration_minutes,
           topic_studied, goal, work_method, practical_application,
           connection_cooperation, coping_achieving_goals, environment_comments, lateness, absences
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        student.id, ctx.user.userId, str(b.lesson_date), str(b.teacher_name), str(b.teacher_phone), str(b.convenient_hours),
        str(b.study_days), str(b.guidance_date), str(b.reassessment_recommendation), str(b.reassessment_date),
        toIntOrNull(b.week_number), toIntOrNull(b.meeting_number), toIntOrNull(b.study_duration_minutes),
        str(b.topic_studied), str(b.goal), str(b.work_method), str(b.practical_application),
        str(b.connection_cooperation), str(b.coping_achieving_goals), str(b.environment_comments), str(b.lateness), str(b.absences)
      );

    for (const field of DICTIONARY_FIELDS) {
      if (str(b[field])) rememberPhrase(ctx.user.userId, `lesson_${field}`, b[field]);
    }

    const report = db.prepare("SELECT * FROM lesson_reports WHERE id = ?").get(info.lastInsertRowid);
    return json(ctx.res, 201, { lesson_report: report });
  }));

  // "מילון" ניסוחים לשדות טופס "הכנה לשיעור" - kind בפורמט lesson_<שם השדה>, למשל lesson_topic_studied
  router.get("/api/lesson-reports/dictionary", requireAuth(async (ctx) => {
    const kind = ctx.query.kind || "";
    if (!kind.startsWith("lesson_") || !DICTIONARY_FIELDS.includes(kind.slice("lesson_".length))) {
      return json(ctx.res, 400, { error: "kind לא תקין" });
    }
    return json(ctx.res, 200, { phrases: getDictionary(ctx.user.userId, kind) });
  }));
}

module.exports = { register, DICTIONARY_FIELDS };
