// ivr.js — מנוע השיחה הקולית: Webhook עבור Twilio. מכונת מצבים שמזהה מילות מפתח בעברית
// מתוך התמלול שמחזיר Twilio (<Gather input="speech">), אוספת נתונים, ותמיד קוראת אותם חזרה
// לאישור (read-back) לפני שמירה, בדיוק כמו בסימולטור שבאב-הטיפוס.
//
// זרימת Webhook טיפוסית מול Twilio:
//   1) שיחה נכנסת -> Twilio שולח POST ל-/api/ivr/voice עם From (מספר המתקשר)
//   2) אנחנו מזהים משתמש לפי מספר טלפון, ומשיבים TwiML עם <Gather> ששואל לאיזו קטגוריה להיכנס
//   3) Twilio מקליט/מזהה דיבור, ושולח POST חזרה ל-action עם SpeechResult (התמלול) + CallSid
//   4) אנחנו טוענים את מצב השיחה השמור (call_logs), מתקדמים במכונת המצבים, ומשיבים TwiML הבא
//   5) חוזר חלילה עד לצומת "done_*" שבו קוראים תוצאה סופית ומנתקים
//
// אם מספר הטלפון לא מזוהה - לא מנתקים מיד: מציעים הרשמה ישירות בטלפון (advanceSignup), כדי
// שלא חייבים לגשת לאתר קודם. מכונת המצבים הזו (advance) ומכונת ההרשמה (advanceSignup) משותפות
// גם לאינטגרציית ימות המשיח (routes/yemot.js) - בלי לשכפל לוגיקה בין שני ספקי הטלפוניה.
"use strict";

const crypto = require("crypto");
const db = require("../db");
const { xml } = require("../router");
const { sayAndGather, sayAndHangup } = require("../services/telephony");
const { hashPassword } = require("../utils/crypto");

const MAIN_MENU_HINTS = [
  "ניהול חשבונות", "חשבונות", "תנועות", "הכנסה", "הוצאה", "יתרה",
  "חונכות", "מטפלים", "דיווח", "הורה", "מפקח", "הערת מפקח", "הערה",
];

function register(router) {
  // כניסה לשיחה
  router.post("/api/ivr/voice", async (ctx) => {
    const from = ctx.body.From;
    const callSid = ctx.body.CallSid;
    const user = db.prepare("SELECT * FROM users WHERE phone = ? OR phone2 = ?").get(from, from);

    if (!user) {
      upsertCall(callSid, null, "signup_name", { phone: from });
      return xml(
        ctx.res,
        200,
        sayAndGather({
          text: "מספר הטלפון שלך אינו מזוהה במערכת. אפשר להירשם עכשיו ישירות בטלפון, בלי לגשת לאתר. מה השם המלא שלכם?",
          actionPath: "/api/ivr/handle",
          hints: [],
        })
      );
    }

    upsertCall(callSid, user.id, "main_menu", {});
    return xml(
      ctx.res,
      200,
      sayAndGather({ text: mainMenuPrompt(user.full_name), actionPath: "/api/ivr/handle", hints: MAIN_MENU_HINTS })
    );
  });

  // כל שאר הצעדים בשיחה
  router.post("/api/ivr/handle", async (ctx) => {
    const callSid = ctx.body.CallSid;
    const speech = (ctx.body.SpeechResult || "").trim();
    const call = db.prepare("SELECT * FROM call_logs WHERE call_sid = ?").get(callSid);
    if (!call) {
      return xml(ctx.res, 200, sayAndHangup("אירעה תקלה בזיהוי השיחה. יש לנסות שוב."));
    }

    appendTranscript(callSid, speech);
    const draft = JSON.parse(call.draft_json || "{}");

    // Twilio: אין כרגע קליטת הקשות (dtmf) מוגדרת ב-<Gather>, לכן אין תמיכה ב"הקישו סולמית" בערוץ הזה -
    // ר' הערה מפורטת ב-services/yemot.js למה זה קיים רק בימות.
    const result = call.user_id
      ? await advance(call.state, speech, draft, db.prepare("SELECT * FROM users WHERE id = ?").get(call.user_id))
      : await advanceSignup(call.state, speech, draft);

    upsertCall(callSid, result.newUserId || call.user_id, result.nextState, result.draft || draft, result.outcome);
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

// ---------- ברכת פתיחה / תפריט ראשי (משותף לTwilio ולימות) ----------
function mainMenuPrompt(name) {
  return `${name ? `שלום ${name}, ` : "שלום, "}הגעתם לפנקס שלי. נא לציין לאיזה קטגוריה אתם רוצים להיכנס: ${mainMenuCategoriesText()}`;
}
function mainMenuCategoriesText() {
  return "ניהול חשבונות, תנועות, חונכות, מטפלים, הורה, או הערת מפקח.";
}

// ---------- מכונת המצבים ----------
// כל צומת מקבל (speech, draft, user, opts) ומחזיר { text, nextState, draft?, hints?, hangup?, outcome? }
// opts.digitConfirm: true בערוצים שתומכים בהקשת ספרות/סולמית תוך כדי זיהוי דיבור (כרגע: ימות בלבד -
// ר' services/yemot.js) - מוסיף אפשרות אישור מהירה בהקשה, בלי לחכות לזיהוי הדיבור על המילה "כן".
async function advance(state, speech, draft, user, opts = {}) {
  const s = normalize(speech);

  switch (state) {
    case "main_menu": {
      if (includesAny(s, ["ניהול חשבונות", "חשבונות", "יתרה", "מצב חשבון"])) return doBalance(user);
      if (includesAny(s, ["הוצאה"])) return { text: "כמה עלה? אפשר לומר סכום בשקלים.", nextState: "expense_amount" };
      if (includesAny(s, ["הכנסה"])) return { text: "מה סכום ההכנסה?", nextState: "income_amount" };
      if (includesAny(s, ["תנועות", "תנועה"])) return { text: "הכנסה או הוצאה?", nextState: "transactions_pick_type" };
      if (includesAny(s, ["חונכות", "תלמיד"])) return { text: "מה שם התלמיד?", nextState: "mentor_pick_student" };
      if (includesAny(s, ["מטפלים", "מטפל", "דיווח", "ריפוי", "רגשי"])) return { text: "מה סוג הדיווח: ריפוי בעיסוק, טיפול רגשי, או אחר?", nextState: "therapist_role" };
      if (includesAny(s, ["הורה"])) return startGuardianFlow(user);
      if (includesAny(s, ["מפקח", "הערת מפקח", "הערה"])) return { text: "על איזה תלמיד ההערה?", nextState: "supervisor_pick_student" };
      return { text: `לא הבנתי. אפשר לומר: ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
    }

    // ---------- תנועות: בחירת סוג (הכנסה/הוצאה) ----------
    case "transactions_pick_type": {
      if (includesAny(s, ["הוצאה"])) return { text: "כמה עלה? אפשר לומר סכום בשקלים.", nextState: "expense_amount" };
      if (includesAny(s, ["הכנסה"])) return { text: "מה סכום ההכנסה?", nextState: "income_amount" };
      return { text: "לא הבנתי. הכנסה או הוצאה?", nextState: "transactions_pick_type" };
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
        text: `לאשר: הוצאה של ${draft.amount} שקלים בקטגוריית ${category}? אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "expense_confirm",
        draft: { ...draft, category },
      };
    }
    case "expense_confirm": {
      if (!isConfirmYes(s, opts)) return { text: `בוטל. אפשר להתחיל שוב, מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      db.prepare("INSERT INTO transactions (user_id, type, amount, category, source) VALUES (?, 'expense', ?, ?, 'phone')")
        .run(user.id, draft.amount, draft.category);
      return { text: `נשמר. הוצאה של ${draft.amount} שקלים ב${draft.category}. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "expense_saved" };
    }

    // ---------- הכנסה ----------
    case "income_amount": {
      const amount = extractAmount(s);
      if (!amount) return { text: "לא זיהיתי סכום. מה סכום ההכנסה?", nextState: "income_amount" };
      return { text: `לאשר: הכנסה של ${amount} שקלים? אמרו כן לאישור.${confirmSuffix(opts)}`, nextState: "income_confirm", draft: { amount } };
    }
    case "income_confirm": {
      if (!isConfirmYes(s, opts)) return { text: `בוטל. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
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
        text: `לאשר דיווח על ${draft.studentName}: ${speech}. אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "therapist_confirm",
        draft: { ...draft, note: speech },
      };
    }
    case "therapist_confirm": {
      if (!isConfirmYes(s, opts)) return { text: `בוטל. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      db.prepare(
        "INSERT INTO therapy_reports (student_id, professional_user_id, role_type, note, trend, transcript) VALUES (?, ?, ?, ?, 'יציבה', ?)"
      ).run(draft.studentId, user.id, draft.role, draft.note, draft.note);
      return { text: `הדיווח נשמר עבור ${draft.studentName}. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "report_saved" };
    }

    // ---------- הורה: סיכום קולי על הילד/ים ----------
    case "guardian_pick_child": {
      const options = draft.children || [];
      const match = options.find((c) => normalize(c.name).includes(s) || s.includes(normalize(c.name)));
      if (!match) return { text: "לא זיהיתי את השם. אפשר לומר שוב את שם הילד?", nextState: "guardian_pick_child" };
      return guardianSummaryResult(match);
    }

    // ---------- הערת מפקח ----------
    case "supervisor_pick_student": {
      const student = findStudentByName(null, s);
      if (!student) return { text: "לא מצאתי תלמיד בשם הזה. אפשר לומר שוב?", nextState: "supervisor_pick_student" };
      return { text: "מה תוכן ההערה?", nextState: "supervisor_readback", draft: { studentId: student.id, studentName: student.name } };
    }
    case "supervisor_readback": {
      return {
        text: `לאשר הערה על ${draft.studentName}: ${speech}. אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "supervisor_confirm",
        draft: { ...draft, text: speech },
      };
    }
    case "supervisor_confirm": {
      if (!isConfirmYes(s, opts)) return { text: `בוטל. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      db.prepare("INSERT INTO student_comments (student_id, author_user_id, author_label, text) VALUES (?, ?, ?, ?)")
        .run(draft.studentId, user.id, `${user.full_name} (דרך השיחה הקולית)`, draft.text);
      return { text: `ההערה נשמרה בתיק ${draft.studentName}. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "comment_saved" };
    }

    default:
      return { text: `מתחילים מחדש. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
  }
}

// ---------- מכונת מצבים נפרדת: הרשמה טלפונית למספר לא מזוהה (בלי צורך ב-user קיים) ----------
// כל צומת מקבל (speech, draft, opts) ומחזיר אותו מבנה כמו advance(), עם newUserId נוסף כשהמשתמש נוצר בפועל.
async function advanceSignup(state, speech, draft, opts = {}) {
  const s = normalize(speech);

  switch (state) {
    case "signup_name": {
      const fullName = String(speech || "").trim();
      if (!fullName) return { text: "לא שמעתי שם. מה השם המלא שלכם?", nextState: "signup_name" };
      return {
        text: `לאשר: נרשמים בשם ${fullName}, עם מספר הטלפון שממנו אתם מתקשרים כרגע? אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "signup_confirm",
        draft: { ...draft, fullName },
      };
    }
    case "signup_confirm": {
      if (!isConfirmYes(s, opts)) {
        return { text: "בסדר, ננסה שוב. מה השם המלא שלכם?", nextState: "signup_name", draft: { phone: draft.phone } };
      }
      const newUser = createPhoneUser(draft.fullName, draft.phone);
      return {
        text: `נרשמת בהצלחה! ${mainMenuPrompt(newUser.full_name)}`,
        nextState: "main_menu",
        newUserId: newUser.id,
        hints: MAIN_MENU_HINTS,
        outcome: "phone_signup_completed",
      };
    }
    default:
      return { text: "מה השם המלא שלכם?", nextState: "signup_name", draft };
  }
}

// יוצר משתמש חדש ישירות מתוך שיחת טלפון - בלי סיסמה שהמשתמש בוחר (הזיהוי בטלפון הוא לפי Caller ID
// בלבד, לא סיסמה). אם ירצו גם גישה לאתר, יוכלו לשחזר סיסמה בכל עת דרך "שכחתי סיסמה" (ערוץ טלפון קולי) -
// אין צורך שהם ידעו את הסיסמה האקראית שנוצרת כאן.
function createPhoneUser(fullName, phone) {
  const digits = String(phone || "").replace(/\D/g, "").slice(-9) || "user";
  let username = `phone_${digits}`;
  let n = 1;
  while (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
    n++;
    username = `phone_${digits}_${n}`;
  }
  const randomPassword = crypto.randomBytes(16).toString("hex");
  const info = db
    .prepare("INSERT INTO users (full_name, username, password_hash, phone, roles) VALUES (?, ?, ?, ?, 'private')")
    .run(fullName, username, hashPassword(randomPassword), phone || null);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
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

// מוצא את רשימת הילדים ששויכו למתקשר כהורה (טבלת student_guardians), ומחליט אם לקרוא סיכום מיד
// (ילד יחיד) או לשאול על איזה ילד לקרוא (כמה ילדים).
function startGuardianFlow(user) {
  const children = db
    .prepare(
      `SELECT s.id, s.name FROM student_guardians sg
       JOIN students s ON s.id = sg.student_id
       WHERE sg.guardian_user_id = ? AND s.active = 1 ORDER BY s.name`
    )
    .all(user.id);

  if (!children.length) {
    return { text: "לא נמצאו ילדים המשויכים אליך כהורה במערכת. תודה, להתראות.", nextState: "done", hangup: true, outcome: "guardian_no_children" };
  }
  if (children.length === 1) return guardianSummaryResult(children[0]);

  const names = children.map((c) => c.name).join(", ");
  return {
    text: `יש לך כמה ילדים במערכת: ${names}. על איזה ילד תרצו לשמוע את הסיכום?`,
    nextState: "guardian_pick_child",
    draft: { children: children.map((c) => ({ id: c.id, name: c.name })) },
  };
}

// מקריא סיכום קצר (מספר מפגשים, סך הדקות, ומגמת הדיווח המקצועי האחרון) - בדיוק כמו הסיכום שההורה
// רואה באתר (GET /api/students/:id/summary), רק מוקרא בקול במקום מוצג בכתב.
function guardianSummaryResult(student) {
  const sessions = db.prepare("SELECT duration_minutes FROM sessions WHERE student_id = ?").all(student.id);
  const totalMinutes = sessions.reduce((sum, r) => sum + r.duration_minutes, 0);
  const latestReport = db
    .prepare("SELECT trend FROM therapy_reports WHERE student_id = ? ORDER BY occurred_at DESC LIMIT 1")
    .get(student.id);

  let text = `הסיכום עבור ${student.name}: היו ${sessions.length} מפגשים, בסך הכל ${totalMinutes} דקות.`;
  text += latestReport ? ` הדיווח המקצועי האחרון מציין מגמה: ${latestReport.trend}.` : " אין עדיין דיווח מקצועי בתיק.";
  text += " תודה, להתראות.";
  return { text, nextState: "done", hangup: true, outcome: "guardian_summary_read" };
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

// בודק אם תשובה נחשבת "כן" בצומת אישור: תמיד לפי מילה מדוברת ("כן"/"אישור"/"מאשר"), ובערוצים שתומכים
// בהקשה תוך כדי זיהוי דיבור (opts.digitConfirm) - גם כל הקשה (ספרות ו/או סולמית), כדי לאפשר אישור מהיר
// בלי לחכות לעיבוד הדיבור.
function isConfirmYes(s, opts) {
  if (includesAny(s, ["כן", "אישור", "מאשר"])) return true;
  if (opts && opts.digitConfirm) return /^[#0-9]+$/.test(String(s || "").trim());
  return false;
}

// טקסט נוסף שמצטרף לשאלות אישור בערוצים שתומכים בהקשה (ר' isConfirmYes)
function confirmSuffix(opts) {
  return opts && opts.digitConfirm ? " אפשר גם להקיש סולמית לאישור מהיר." : "";
}

// מנרמל טקסט להשוואה: מוריד רווחים מיותרים, אותיות קטנות (לא רלוונטי בעברית אבל לא מזיק), ומסיר ניקוד -
// כדי שהתאמת שמות/מילות מפתח תהיה סלחנית יותר לשונות קלות בזיהוי הדיבור.
function normalize(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[֑-ׇ]/g, "") // תווי ניקוד עברי
    .replace(/\s+/g, " ");
}

function upsertCall(callSid, userId, state, draft, outcome) {
  const existing = db.prepare("SELECT id FROM call_logs WHERE call_sid = ?").get(callSid);
  if (existing) {
    db.prepare("UPDATE call_logs SET user_id = COALESCE(?, user_id), state = ?, draft_json = ?, outcome = COALESCE(?, outcome) WHERE call_sid = ?")
      .run(userId || null, state, JSON.stringify(draft || {}), outcome || null, callSid);
  } else {
    db.prepare("INSERT INTO call_logs (call_sid, user_id, state, draft_json, outcome) VALUES (?, ?, ?, ?, ?)")
      .run(callSid, userId || null, state, JSON.stringify(draft || {}), outcome || null);
  }
}

function appendTranscript(callSid, speech) {
  if (!speech) return;
  const row = db.prepare("SELECT transcript FROM call_logs WHERE call_sid = ?").get(callSid);
  const updated = (row?.transcript ? row.transcript + " | " : "") + speech;
  db.prepare("UPDATE call_logs SET transcript = ? WHERE call_sid = ?").run(updated, callSid);
}

// מיוצא כדי שנוכל להשתמש באותה מכונת מצבים גם עבור אינטגרציית ימות המשיח (routes/yemot.js) -
// בלי לשכפל את כל לוגיקת השיחה בין שני ספקי הטלפוניה.
module.exports = {
  register,
  advance,
  advanceSignup,
  upsertCall,
  appendTranscript,
  MAIN_MENU_HINTS,
  mainMenuPrompt,
};
