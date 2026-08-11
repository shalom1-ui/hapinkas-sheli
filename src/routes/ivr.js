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
// ההודעה נשמרת קצרה בכוונה: כל מילה נוספת כאן מאריכה את זמן ההשמעה לפני שהמערכת מתחילה להאזין,
// וזה בדיוק מה שגורם לתחושת "לא מזהה מיד כשמתחילים לדבר" - ככל שהברכת פתיחה קצרה יותר, ההאזנה
// בפועל מתחילה מוקדם יותר. הרשימה המלאה של מספר<->קטגוריה נשארת ב-README, לא מוקראת כל שיחה.
function mainMenuPrompt(name, opts = {}) {
  // digitConfirm בערוצים שתומכים בהקשה תוך כדי זיהוי דיבור (כרגע: ימות בלבד) - מזכירים כבר בפתיחה
  // שאפשר להקיש ספרה במקום לדבר, ובלי לחכות שהמערכת תסיים להקריא את כל התפריט (ימות לא חוסם הקשה
  // במהלך ההשמעה - ר' services/yemot.js). בכוונה לא חוזרים כאן על כל רשימת הספרות (זה כבר ארוך
  // מספיק בגלל רשימת הקטגוריות עצמה) - מספיק לדעת שאפשר להקיש בכלל.
  // חשוב: כאן לא מזכירים "סולמית לאישור מהיר" - זה תפריט בחירת קטגוריה, לא שאלת כן/לא, ולסולמית
  // אין כאן שום פעולה. הזכרה שגויה שלה כאן גרמה בעבר לכך שמתקשרים ניסו להקיש סולמית במסך הזה ולא
  // קרה כלום חוץ מ"לא זוהה דיבור" אחרי המתנה - ר' isConfirmYes/confirmSuffix למקומות שבהם סולמית כן פעילה.
  const digitNote = opts.digitConfirm ? " אפשר גם להקיש 1 עד 6." : "";
  return `${name ? `שלום ${name}, ` : "שלום, "}הגעתם לפנקס שלי. נא לציין קטגוריה: ${mainMenuCategoriesText()}${digitNote}`;
}
function mainMenuCategoriesText() {
  return "ניהול חשבונות, תנועות, חונכות, מטפלים, הורה, או הערת מפקח.";
}

// ---------- קיצורי הקשה (DTMF) לתפריט הראשי ----------
// ימות מאפשרת הקשת ספרות תוך כדי זיהוי דיבור בלי לחסום (ר' services/yemot.js) - כלומר אפשר להקיש
// כבר תוך כדי השמעת התפריט, בלי לחכות. הספרה שהוקשה מגיעה באותו שדה כמו הדיבור, ולכן פשוט ממירים
// אותה למילת המפתח המתאימה ומריצים אותה דרך אותה לוגיקת ההתאמה הרגילה (includesAny).
const MAIN_MENU_DIGIT_KEYWORDS = {
  "1": "ניהול חשבונות",
  "2": "תנועות",
  "3": "חונכות",
  "4": "מטפלים",
  "5": "הורה",
  "6": "הערת מפקח",
};
function mainMenuDigitKeyword(s) {
  const digits = onlyDigits(s);
  return digits && MAIN_MENU_DIGIT_KEYWORDS[digits] ? normalize(MAIN_MENU_DIGIT_KEYWORDS[digits]) : null;
}
// שולף ספרות בלבד מתוך קלט (כולל כשמעורבת בו גם סולמית) - מחזיר null אם אין ספרות בכלל
function onlyDigits(s) {
  const digits = String(s || "").replace(/[^0-9]/g, "");
  return digits || null;
}

// הודעת "הכנסה או הוצאה" בתפריט תנועות - עם רמז הקשה (1/2) בערוצים שתומכים בזה
function transactionsTypePrompt(opts) {
  return `הכנסה או הוצאה?${opts && opts.digitConfirm ? " (אפשר גם להקיש: 1 להכנסה, 2 להוצאה)" : ""}`;
}
// טקסט אפשרויות שלב בחירת הפעולה בחונכות (משותף לכל הצמתים שמגיעים לשלב הזה)
// משתמשים במילים עבריות פשוטות ("כניסה"/"יציאה") ולא ב"צ'ק אין"/"צ'ק אאוט" (תעתיק אנגלית) - זה גם
// יותר ברור למתקשר, וגם יותר קל לזיהוי דיבור: המערכת מקריאה בעברית, אז עדיף שגם המתקשר יחזור
// במילה עברית טבעית ולא ינסה לחקות ביטוי לועזי. לוגיקת ההתאמה (case "mentor_action") עדיין מקבלת
// גם "אין"/"אאוט" כמילות מפתח נוספות לנוחות, ליתר בטחון.
function mentorActionPrompt(studentName, opts) {
  return `${studentName}. האם זה כניסה, יציאה, מפגש רגיל, או הסרת התלמיד?${mentorActionDigitsNote(opts)}`;
}
// רמז הקשה (1/2/3/4) לשלב בחירת סוג הפעולה בחונכות (כניסה / יציאה / מפגש רגיל / הסרת תלמיד)
function mentorActionDigitsNote(opts) {
  return opts && opts.digitConfirm ? " אפשר גם להקיש: 1 לכניסה, 2 ליציאה, 3 למפגש רגיל, 4 להסרת התלמיד." : "";
}
// רמז הקשה (1/2) לשלב "האם להוסיף תלמיד חדש שלא נמצא ברשימה"
function addStudentDigitsNote(opts) {
  return opts && opts.digitConfirm ? " אפשר גם להקיש: 1 להוספה, 2 לביטול." : "";
}

// ---------- מכונת המצבים ----------
// כל צומת מקבל (speech, draft, user, opts) ומחזיר { text, nextState, draft?, hints?, hangup?, outcome? }
// opts.digitConfirm: true בערוצים שתומכים בהקשת ספרות/סולמית תוך כדי זיהוי דיבור (כרגע: ימות בלבד -
// ר' services/yemot.js) - מוסיף אפשרות אישור מהירה בהקשה, בלי לחכות לזיהוי הדיבור על המילה "כן".
async function advance(state, speech, draft, user, opts = {}) {
  const s = normalize(speech);

  switch (state) {
    case "main_menu": {
      // אפשר להקיש ספרה (1-6) במקום לדבר - ר' MAIN_MENU_DIGIT_KEYWORDS. מתייחסים אליה כאילו נאמרה
      // מילת המפתח המתאימה, ומריצים דרך אותה לוגיקת התאמה כרגיל.
      const es = mainMenuDigitKeyword(s) || s;
      if (includesAny(es, ["ניהול חשבונות", "חשבונות", "יתרה", "מצב חשבון"])) return doBalance(user);
      if (includesAny(es, ["הוצאה"])) return { text: "כמה עלה? אפשר לומר סכום בשקלים.", nextState: "expense_amount" };
      if (includesAny(es, ["הכנסה"])) return { text: "מה סכום ההכנסה?", nextState: "income_amount" };
      if (includesAny(es, ["תנועות", "תנועה"])) return { text: transactionsTypePrompt(opts), nextState: "transactions_pick_type" };
      if (includesAny(es, ["חונכות", "תלמיד"])) return { text: "מה שם התלמיד?", nextState: "mentor_pick_student" };
      if (includesAny(es, ["מטפלים", "מטפל", "דיווח", "ריפוי", "רגשי"])) return { text: "מה סוג הדיווח: ריפוי בעיסוק, טיפול רגשי, או אחר?", nextState: "therapist_role" };
      if (includesAny(es, ["הורה"])) return startGuardianFlow(user);
      if (includesAny(es, ["מפקח", "הערת מפקח", "הערה"])) return { text: "על איזה תלמיד ההערה?", nextState: "supervisor_pick_student" };
      return { text: `לא הבנתי. אפשר לומר: ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
    }

    // ---------- תנועות: בחירת סוג (הכנסה/הוצאה) ----------
    case "transactions_pick_type": {
      const digit = onlyDigits(s);
      if (digit === "2" || includesAny(s, ["הוצאה"])) return { text: "כמה עלה? אפשר לומר סכום בשקלים.", nextState: "expense_amount" };
      if (digit === "1" || includesAny(s, ["הכנסה"])) return { text: "מה סכום ההכנסה?", nextState: "income_amount" };
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
    // חונך הוא ה"רושם" של תלמידיו (owner_user_id) - לכן אם הוא אומר שם תלמיד שעדיין לא רשום אצלו,
    // מציעים להוסיף אותו כתלמיד חדש מיד בטלפון (בלי לחייב מעבר לאתר) - ר' mentor_confirm_add_student.
    case "mentor_pick_student": {
      const student = findStudentByName(user.id, s);
      if (student) {
        return {
          text: mentorActionPrompt(student.name, opts),
          nextState: "mentor_action",
          draft: { studentId: student.id, studentName: student.name },
        };
      }
      const spokenName = String(speech || "").trim();
      if (!spokenName) return { text: "לא שמעתי שם. מה שם התלמיד?", nextState: "mentor_pick_student" };
      return {
        text: `לא מצאתי תלמיד בשם ${spokenName} ברשימת התלמידים שלך. רוצים להוסיף אותו כתלמיד חדש?${addStudentDigitsNote(opts)}`,
        nextState: "mentor_confirm_add_student",
        draft: { pendingStudentName: spokenName },
      };
    }
    case "mentor_confirm_add_student": {
      const digit = onlyDigits(s);
      const wantsAdd = digit === "1" || includesAny(s, ["כן", "אישור", "מאשר", "הוסיפו", "הוסף"]);
      const wantsCancel = digit === "2" || includesAny(s, ["לא", "ביטול", "בטל"]);
      if (wantsAdd) {
        const info = db.prepare("INSERT INTO students (owner_user_id, name) VALUES (?, ?)").run(user.id, draft.pendingStudentName);
        return {
          text: `נוסף תלמיד חדש: ${draft.pendingStudentName}. ${mentorActionPrompt(draft.pendingStudentName, opts)}`,
          nextState: "mentor_action",
          draft: { studentId: info.lastInsertRowid, studentName: draft.pendingStudentName },
        };
      }
      if (wantsCancel) {
        return { text: `בסדר, לא הוספנו. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      }
      // כל תשובה אחרת - מנסים שוב כאילו זה שם תלמיד (יתכן וזה ניסיון תיקון/חזרה על השם)
      const retryStudent = findStudentByName(user.id, s);
      if (retryStudent) {
        return {
          text: mentorActionPrompt(retryStudent.name, opts),
          nextState: "mentor_action",
          draft: { studentId: retryStudent.id, studentName: retryStudent.name },
        };
      }
      const retryName = String(speech || "").trim();
      if (!retryName) return { text: "לא שמעתי שם. מה שם התלמיד?", nextState: "mentor_pick_student" };
      return {
        text: `גם בשם ${retryName} לא מצאתי תלמיד ברשימה שלך. רוצים להוסיף אותו כתלמיד חדש?${addStudentDigitsNote(opts)}`,
        nextState: "mentor_confirm_add_student",
        draft: { pendingStudentName: retryName },
      };
    }
    case "mentor_action": {
      const digit = onlyDigits(s);
      if (digit === "2" || includesAny(s, ["אאוט", "יציאה", "סיום"])) return doCheckout(draft, user);
      if (digit === "1" || includesAny(s, ["אין", "כניסה", "התחלה"])) return doCheckin(draft);
      if (digit === "3" || includesAny(s, ["רגיל", "מהיר", "קבוע"])) return doQuickSession(draft, user);
      if (digit === "4" || includesAny(s, ["הסר", "הסרה", "מחיקה", "מחק", "לא לומד", "הפסיק"])) {
        return {
          text: `לאשר: להסיר את ${draft.studentName} מרשימת התלמידים שלך? התלמיד לא יימחק לצמיתות, רק לא יופיע יותר ברשימה הפעילה - כל ההיסטוריה שלו נשארת בתיק. אמרו כן לאישור.${confirmSuffix(opts)}`,
          nextState: "mentor_remove_confirm",
          draft,
        };
      }
      return { text: `לא הבנתי. ${mentorActionPrompt(draft.studentName, opts)}`, nextState: "mentor_action" };
    }
    case "mentor_remove_confirm": {
      if (!isConfirmYes(s, opts)) return { text: `בסדר, לא הסרנו. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      db.prepare("UPDATE students SET active = 0 WHERE id = ? AND owner_user_id = ?").run(draft.studentId, user.id);
      return { text: `${draft.studentName} הוסר/ה מרשימת התלמידים הפעילים שלך. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "student_removed" };
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
      return {
        text: "אפשר גם לצרף כתובת מייל לחשבון, זה לא חובה. אם תרצו - אמרו אותה עכשיו. אם לא, אמרו דלג.",
        nextState: "signup_email",
        draft,
      };
    }
    // מייל אופציונלי בהרשמה טלפונית - הזיהוי עצמו נשען על מספר הטלפון (Caller ID), לא על המייל/סיסמה,
    // אבל מייל מאפשר בעתיד גם שחזור/כניסה מהאתר בצורה נוחה יותר. אם הזיהוי מהדיבור לא נשמע כמו כתובת
    // מייל תקינה - לא תוקעים את השיחה בלולאה, פשוט ממשיכים בלי מייל (אפשר להוסיף מאוחר יותר באתר).
    case "signup_email": {
      if (includesAny(s, ["דלג", "לא", "אין", "בלי", "לדלג", "המשך"])) {
        const newUser = createPhoneUser(draft.fullName, draft.phone, null);
        return {
          text: `נרשמת בהצלחה! ${mainMenuPrompt(newUser.full_name, opts)}`,
          nextState: "main_menu",
          newUserId: newUser.id,
          hints: MAIN_MENU_HINTS,
          outcome: "phone_signup_completed",
        };
      }
      const email = parseSpokenEmail(speech);
      const newUser = createPhoneUser(draft.fullName, draft.phone, email);
      const emailNote = email ? `נשמרה גם כתובת המייל ${email}. ` : "לא זיהיתי כתובת מייל תקינה, ממשיכים בלי מייל - אפשר להוסיף אותה מאוחר יותר באתר. ";
      return {
        text: `נרשמת בהצלחה! ${emailNote}${mainMenuPrompt(newUser.full_name, opts)}`,
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

// ניסיון "כמיטב היכולת" להמיר מה שנאמר בקול לכתובת מייל: זיהוי דיבור בעברית לא קורא תווים כמו @ ונקודה
// כמו שהם, אז אנשים בדרך כלל אומרים "כרוכית"/"שטרודל" או "at" במקום @, ו"נקודה"/"dot" במקום נקודה.
// מחזיר null אם התוצאה לא נראית כמו כתובת מייל תקינה - כדי שלא נשמור זבל בשדה המייל.
function parseSpokenEmail(rawSpeech) {
  let t = String(rawSpeech || "").trim().toLowerCase();
  t = t.replace(/\s*(כרוכית|שטרודל|@|\bat\b)\s*/g, "@");
  t = t.replace(/\s*(נקודה|\bdot\b|\.)\s*/g, ".");
  t = t.replace(/\s+/g, "");
  const isValid = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(t);
  return isValid ? t : null;
}

// יוצר משתמש חדש ישירות מתוך שיחת טלפון - בלי סיסמה שהמשתמש בוחר (הזיהוי בטלפון הוא לפי Caller ID
// בלבד, לא סיסמה). אם ירצו גם גישה לאתר, יוכלו לשחזר סיסמה בכל עת דרך "שכחתי סיסמה" (ערוץ טלפון קולי) -
// אין צורך שהם ידעו את הסיסמה האקראית שנוצרת כאן.
function createPhoneUser(fullName, phone, email) {
  const digits = String(phone || "").replace(/\D/g, "").slice(-9) || "user";
  let username = `phone_${digits}`;
  let n = 1;
  while (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
    n++;
    username = `phone_${digits}_${n}`;
  }
  const randomPassword = crypto.randomBytes(16).toString("hex");
  // signup_channel='phone' בכוונה מפורשת - חשבון שנוצר כך (סיסמה אקראית, לא נבחרה בפועל) לא כשיר
  // להיות "בעל הקו" (ר' /api/me/request-admin-claim ב-routes/auth.js).
  const info = db
    .prepare("INSERT INTO users (full_name, username, password_hash, phone, email, roles, signup_channel) VALUES (?, ?, ?, ?, ?, 'private', 'phone')")
    .run(fullName, username, hashPassword(randomPassword), phone || null, email || null);
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
  return { text: `נרשמה כניסה עבור ${student.name}. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "checkin_saved" };
}

function doCheckout(draft, user) {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(draft.studentId);
  if (!student.checkin_at) return { text: "אין מפגש פתוח לתלמיד הזה. להתראות.", nextState: "done", hangup: true };
  const start = new Date(student.checkin_at + "Z");
  const durationMinutes = Math.max(1, Math.round((Date.now() - start.getTime()) / 60000));
  db.prepare("INSERT INTO sessions (student_id, mentor_user_id, method, duration_minutes) VALUES (?, ?, 'checkin_checkout', ?)")
    .run(student.id, user.id, durationMinutes);
  db.prepare("UPDATE students SET checkin_at = NULL WHERE id = ?").run(student.id);
  return { text: `נרשמה יציאה עבור ${student.name}. משך המפגש: ${durationMinutes} דקות. תודה, להתראות.`, nextState: "done", hangup: true, outcome: "checkout_saved" };
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
