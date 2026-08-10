// ivr.js — מנוע השיחה הקולית: Webhook עבור Twilio. מכונת מצבים שמזהה מילות מפתח בעברית
// מתוך התמלול שמחזיר Twilio (<Gather input="speech">), אוספת נתונים, ותמיד קוראת אותם חזרה
// לאישור (read-back) לפני שמירה, בדיוק כמו בסימולטור שבאב-הטיפוס.
//
// זרימת Webhook טיפוסית מול Twilio:
//   1) שיחה נכנסת -> Twilio שולח POST ל-/api/ivr/voice עם From (מספר המתקשר)
//   2) אנחנו מזהים משתמש לפי מספר טלפון, ומשיבים TwiML עם <Gather> ששואל "מה תרצו לעשות?"
//   3) Twilio מקליט/מזהה דיבור, ושולח POST חזרה ל-action עם SpeechResult (התמלול) + CallSid
//   4) אנחנו טוענים את מצב השיחה השמור (call_logs), מתקדמים במכונת המצבים, ומשיבים TwiML הבא
//   5) חוזר חלילה עד לצומת "done_*" שבו קוראים תוצאה סופית ומנתקים
"use strict";

const db = require("../db");
const { xml } = require("../router");
const { sayAndGather, sayAndHangup } = require("../services/telephony");

const MAIN_MENU_HINTS = ["הכנסה", "הוצאה", "יתרה", "חונכות", "דיווח", "מטפל", "מפקח", "הערה"];

function register(router) {
  // כניסה לשיחה
  router.post("/api/ivr/voice", async (ctx) => {
    const from = ctx.body.From;
    const callSid = ctx.body.CallSid;
    const user = db.prepare("SELECT * FROM users WHERE phone = ? OR phone2 = ?").get(from, from);

    if (!user) {
      db.prepare(
        "INSERT INTO call_logs (call_sid, state, outcome) VALUES (?, 'unidentified', 'hangup_unidentified') ON CONFLICT(call_sid) DO NOTHING"
      ).run(callSid);
      return xml(ctx.res, 200, sayAndHangup("מספר הטלפון שלך אינו מזוהה במערכת. יש להירשם דרך האזור האישי באתר תחילה."));
    }

    upsertCall(callSid, user.id, "main_menu", {});
    return xml(
      ctx.res,
      200,
      sayAndGather({
        text: `שלום ${user.full_name}. אפשר לומר: הכנסה, הוצאה, יתרה, חונכות, דיווח מטפל, או הערת מפקח.`,
        actionPath: "/api/ivr/handle",
        hints: MAIN_MENU_HINTS,
      })
    );
  });

  // כל שאר הצעדים בשיחה
  router.post("/api/ivr/handle", async (ctx) => {
    const callSid = ctx.body.CallSid;
    const speech = (ctx.body.SpeechResult || "").trim();
    const call = db.prepare("SELECT * FROM call_logs WHERE call_sid = ?").get(callSid);
    if (!call || !call.user_id) {
      return xml(ctx.res, 200, sayAndHangup("אירעה תקלה בזיהוי השיחה. יש לנסות שוב."));
    }

    appendTranscript(callSid, speech);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(call.user_id);
    const draft = JSON.parse(call.draft_json || "{}");

    const result = await advance(call.state, speech, draft, user);

    upsertCall(callSid, user.id, result.nextState, result.draft || draft, result.outcome);
    if (result.hangup) {
      return xml(ctx.res, 200, sayAndHangup(result.text));
    }
    return xml(
      ctx.res,
      200,
      sayAndGather({ text: result.text, actionPath: "/api/ivr/handle", hints: result.hints || [] })
    );
  });
}

// ---------- מכונת המצבים ----------
// כל צומת מקבל (speech, draft, user) ומחזיר { text, nextState, draft?, hints?, hangup?, outcome? }
async function advance(state, speech, draft, user) {
  const s = normalize(speech);

  switch (state) {
    case "main_menu": {
      if (includesAny(s, ["הוצאה"])) return { text: "כמה עלה? אפשר לומר סכום בשקלים.", nextState: "expense_amount" };
      if (includesAny(s, ["הכנסה"])) return { text: "מה סכום ההכנסה?", nextState: "income_amount" };
      if (includesAny(s, ["יתרה", "מצב חשבון"])) return doBalance(user);
      if (includesAny(s, ["חונכות", "תלמיד"])) return { text: "מה שם התלמיד?", nextState: "mentor_pick_student" };
      if (includesAny(s, ["דיווח", "מטפל", "ריפוי", "רגשי"])) return { text: "מה סוג הדיווח: ריפוי בעיסוק, טיפול רגשי, או אחר?", nextState: "therapist_role" };
      if (includesAny(s, ["מפקח", "הערה"])) return { text: "על איזה תלמיד ההערה?", nextState: "supervisor_pick_student" };
      return { text: "לא הבנתי. אפשר לומר: הכנסה, הוצאה, יתרה, חונכות, דיווח מטפל, או הערת מפקח.", nextState: "main_menu", hints: MAIN_MENU_HINTS };
    }

    // ---------- הוצאה ----------
    case "expense_amount": {
      const amount = extractAmount(s);
      if (!amount) return { text: "לא זיהיתי סכום. כמה עלה, בשקלים?", nextState: "expense_amount" };
      return { text: "לאיזו קטגוריה? למשל: מזון, תחבורה, דיור, אחר.", nextState: "expense_category", draft: { amount } };
    }
    case "expense_category": {
      const category = s || "אחר";
      return {
        text: `לאשר: הוצאה של ${draft.amount} שקלים בקטגוריית ${category}? אמרו כן לאישור.`,
        nextState: "expense_confirm",
        draft: { ...draft, category },
      };
    }
    case "expense_confirm": {
      if (!includesAny(s, ["כן", "אישור", "מאשר"])) return { text: "בוטל. אפשר להתחיל שוב, מה תרצו לעשות?", nextState: "main_menu", hints: MAIN_MENU_HINTS };
      db.prepare("INSERT INTO transactions (user_id, type, amount, category, source) VALUES (?, 'expense', ?, ?, 'phone')")
        .run(user.id, draft.amount, draft.category);
      return { text: `נשמר. הוצאה של ${draft.amount} שקלים ב${draft.category}. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "expense_saved" };
    }

    // ---------- הכנסה ----------
    case "income_amount": {
      const amount = extractAmount(s);
      if (!amount) return { text: "לא זיהיתי סכום. מה סכום ההכנסה?", nextState: "income_amount" };
      return { text: `לאשר: הכנסה של ${amount} שקלים? אמרו כן לאישור.`, nextState: "income_confirm", draft: { amount } };
    }
    case "income_confirm": {
      if (!includesAny(s, ["כן", "אישור", "מאשר"])) return { text: "בוטל. מה תרצו לעשות?", nextState: "main_menu", hints: MAIN_MENU_HINTS };
      db.prepare("INSERT INTO transactions (user_id, type, amount, source) VALUES (?, 'income', ?, 'phone')").run(user.id, draft.amount);
      return { text: `נשמר. הכנסה של ${draft.amount} שקלים. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "income_saved" };
    }

    // ---------- חונכות ----------
    case "mentor_pick_student": {
      const student = findStudentByName(user.id, s);
      if (!student) return { text: "לא מצאתי תלמיד בשם הזה. אפשר לומר שוב את שם התלמיד?", nextState: "mentor_pick_student" };
      return { text: `${student.name}. האם זה צ'ק אין, צ'ק אאוט, או מפגש רגיל?`, nextState: "mentor_action", draft: { studentId: student.id, studentName: student.name } };
    }
    case "mentor_action": {
      if (includesAny(s, ["אאוט", "יציאה", "סיום"])) return doCheckout(draft, user);
      if (includesAny(s, ["אין", "כניסה", "התחלה"])) return doCheckin(draft);
      if (includesAny(s, ["רגיל", "מהיר", "קבוע"])) return doQuickSession(draft, user);
      return { text: "לא הבנתי. אפשר לומר: צ'ק אין, צ'ק אאוט, או מפגש רגיל?", nextState: "mentor_action" };
    }

    // ---------- דיווח מטפל ----------
    case "therapist_role": {
      let role = null;
      if (includesAny(s, ["ריפוי", "בעיסוק"])) role = "ריפוי בעיסוק";
      else if (includesAny(s, ["רגשי"])) role = "טיפול רגשי";
      else role = "אחר";
      return { text: "על איזה תלמיד הדיווח?", nextState: "therapist_student", draft: { role } };
    }
    case "therapist_student": {
      const student = findStudentByName(null, s);
      if (!student) return { text: "לא מצאתי תלמיד בשם הזה. אפשר לומר שוב?", nextState: "therapist_student" };
      return { text: "מה תוכן הדיווח? אפשר לתאר את ההתקדמות והמטרות.", nextState: "therapist_note", draft: { ...draft, studentId: student.id, studentName: student.name } };
    }
    case "therapist_note": {
      return {
        text: `לאשר דיווח על ${draft.studentName}: ${speech}. אמרו כן לאישור.`,
        nextState: "therapist_confirm",
        draft: { ...draft, note: speech },
      };
    }
    case "therapist_confirm": {
      if (!includesAny(s, ["כן", "אישור", "מאשר"])) return { text: "בוטל. מה תרצו לעשות?", nextState: "main_menu", hints: MAIN_MENU_HINTS };
      db.prepare(
        "INSERT INTO therapy_reports (student_id, professional_user_id, role_type, note, trend, transcript) VALUES (?, ?, ?, ?, 'יציבה', ?)"
      ).run(draft.studentId, user.id, draft.role, draft.note, draft.note);
      return { text: `הדיווח נשמר עבור ${draft.studentName}. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "report_saved" };
    }

    // ---------- הערת מפקח ----------
    case "supervisor_pick_student": {
      const student = findStudentByName(null, s);
      if (!student) return { text: "לא מצאתי תלמיד בשם הזה. אפשר לומר שוב?", nextState: "supervisor_pick_student" };
      return { text: "מה תוכן ההערה?", nextState: "supervisor_readback", draft: { studentId: student.id, studentName: student.name } };
    }
    case "supervisor_readback": {
      return {
        text: `לאשר הערה על ${draft.studentName}: ${speech}. אמרו כן לאישור.`,
        nextState: "supervisor_confirm",
        draft: { ...draft, text: speech },
      };
    }
    case "supervisor_confirm": {
      if (!includesAny(s, ["כן", "אישור", "מאשר"])) return { text: "בוטל. מה תרצו לעשות?", nextState: "main_menu", hints: MAIN_MENU_HINTS };
      db.prepare("INSERT INTO student_comments (student_id, author_user_id, author_label, text) VALUES (?, ?, ?, ?)")
        .run(draft.studentId, user.id, `${user.full_name} (דרך השיחה הקולית)`, draft.text);
      return { text: `ההערה נשמרה בתיק ${draft.studentName}. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "comment_saved" };
    }

    default:
      return { text: "מתחילים מחדש. מה תרצו לעשות?", nextState: "main_menu", hints: MAIN_MENU_HINTS };
  }
}

function doBalance(user) {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS expense
       FROM transactions WHERE user_id = ?`
    )
    .get(user.id);
  const balance = row.income - row.expense;
  return { text: `היתרה הנוכחית שלך היא ${balance} שקלים. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "balance_read" };
}

function doCheckin(draft) {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(draft.studentId);
  if (student.checkin_at) return { text: "כבר קיים מפגש פתוח לתלמיד הזה. להתראות.", nextState: "done", hangup: true };
  db.prepare("UPDATE students SET checkin_at = datetime('now') WHERE id = ?").run(student.id);
  return { text: `נרשם צ'ק אין עבור ${student.name}. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "checkin_saved" };
}

function doCheckout(draft, user) {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(draft.studentId);
  if (!student.checkin_at) return { text: "אין מפגש פתוח לתלמיד הזה. להתראות.", nextState: "done", hangup: true };
  const start = new Date(student.checkin_at + "Z");
  const durationMinutes = Math.max(1, Math.round((Date.now() - start.getTime()) / 60000));
  db.prepare("INSERT INTO sessions (student_id, mentor_user_id, method, duration_minutes) VALUES (?, ?, 'checkin_checkout', ?)")
    .run(student.id, user.id, durationMinutes);
  db.prepare("UPDATE students SET checkin_at = NULL WHERE id = ?").run(student.id);
  return { text: `נרשם צ'ק אאוט עבור ${student.name}. משך המפגש: ${durationMinutes} דקות. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "checkout_saved" };
}

function doQuickSession(draft, user) {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(draft.studentId);
  const u = db.prepare("SELECT default_session_minutes FROM users WHERE id = ?").get(user.id);
  const minutes = u.default_session_minutes || 45;
  db.prepare("INSERT INTO sessions (student_id, mentor_user_id, method, duration_minutes) VALUES (?, ?, 'quick_preset', ?)")
    .run(student.id, user.id, minutes);
  return { text: `נרשם מפגש עבור ${student.name}, ${minutes} דקות. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "quick_session_saved" };
}

function findStudentByName(ownerUserId, spokenName) {
  const clean = normalize(spokenName);
  if (!clean) return null;
  const rows = ownerUserId
    ? db.prepare("SELECT * FROM students WHERE owner_user_id = ? AND active = 1").all(ownerUserId)
    : db.prepare("SELECT * FROM students WHERE active = 1").all();
  return rows.find(r => normalize(r.name).includes(clean) || clean.includes(normalize(r.name))) || null;
}

function extractAmount(text) {
  const match = text.replace(/,/g, "").match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function includesAny(text, words) {
  return words.some(w => text.includes(normalize(w)));
}

function normalize(text) {
  return String(text || "").trim().toLowerCase();
}

function upsertCall(callSid, userId, state, draft, outcome) {
  const existing = db.prepare("SELECT id FROM call_logs WHERE call_sid = ?").get(callSid);
  if (existing) {
    db.prepare("UPDATE call_logs SET state = ?, draft_json = ?, outcome = COALESCE(?, outcome) WHERE call_sid = ?")
      .run(state, JSON.stringify(draft || {}), outcome || null, callSid);
  } else {
    db.prepare("INSERT INTO call_logs (call_sid, user_id, state, draft_json, outcome) VALUES (?, ?, ?, ?, ?)")
      .run(callSid, userId, state, JSON.stringify(draft || {}), outcome || null);
  }
}

function appendTranscript(callSid, speech) {
  if (!speech) return;
  const row = db.prepare("SELECT transcript FROM call_logs WHERE call_sid = ?").get(callSid);
  const updated = (row?.transcript ? row.transcript + " | " : "") + speech;
  db.prepare("UPDATE call_logs SET transcript = ? WHERE call_sid = ?").run(updated, callSid);
}

module.exports = { register };
