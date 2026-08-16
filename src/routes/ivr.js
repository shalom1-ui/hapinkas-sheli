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
const { sayAndGather, sayAndGatherDigits, sayAndHangup } = require("../services/telephony");
const { hashPassword, isValidPin } = require("../utils/crypto");

const MAIN_MENU_HINTS = [
  "ניהול חשבונות", "חשבונות", "תנועות", "הכנסה", "הוצאה", "יתרה",
  "חונכות", "מטפלים", "דיווח", "הורה", "מפקח", "הערת מפקח", "הערה",
];

// ברכת פתיחה - נאמרת פעם אחת בלבד, ממש כשמתקשרים (ההודעה הראשונה של שיחה חדשה), לפני כל שאלה
// אחרת (זיהוי משתמש/הצעת הרשמה/תפריט הקטגוריות). בכוונה לא מוכפלת בשום מקום אחר באמצע השיחה
// (למשל אחרי ביטול פעולה שחוזר לתפריט הראשי) - שם זה יישמע מוזר ומיותר לחזור שוב על "הגעתם לקו...".
const OPENING_GREETING = "שלום וברכה, הגעתם לקו הפנקס שלי. ";

// שלבים שמבקשים הקשת קוד ספרות קבוע-אורך במקלדת (כרגע: קוד PIN בהרשמה טלפונית, ר' signup_pin/
// signup_pin_confirm) - לא זיהוי דיבור וגם לא "טקסט חופשי" (ר' FREE_TEXT_STATES ב-routes/yemot.js).
// משותף לשני הספקים: Twilio (sayAndGatherDigits, services/telephony.js) וימות (sayAndReadDigits,
// services/yemot.js) - שניהם עוברים למצב הקשה-בלבד (DTMF/tap) בשלבים האלה, בלי לנסות לזהות דיבור.
const DIGIT_ENTRY_STATES = new Set(["signup_pin", "signup_pin_confirm"]);

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
          text: `${OPENING_GREETING}מספר הטלפון שלך אינו מזוהה במערכת. אפשר להירשם עכשיו ישירות בטלפון, בלי לגשת לאתר. מה השם המלא שלכם?`,
          actionPath: "/api/ivr/handle",
          hints: [],
        })
      );
    }

    upsertCall(callSid, user.id, "main_menu", {});
    return xml(
      ctx.res,
      200,
      sayAndGather({ text: `${OPENING_GREETING}${mainMenuPrompt(user.full_name)}`, actionPath: "/api/ivr/handle", hints: MAIN_MENU_HINTS })
    );
  });

  // כל שאר הצעדים בשיחה
  router.post("/api/ivr/handle", async (ctx) => {
    const callSid = ctx.body.CallSid;
    // "Digits" מגיע רק כשה-<Gather> הקודם היה במצב הקשה (DTMF, ר' DIGIT_ENTRY_STATES/sayAndGatherDigits)
    // ולא כשהוא היה במצב "speech" - שני השדות לעולם לא מגיעים יחד באותה בקשה, אז מיזוג בטוח.
    const speech = (ctx.body.Digits || ctx.body.SpeechResult || "").trim();
    const call = db.prepare("SELECT * FROM call_logs WHERE call_sid = ?").get(callSid);
    if (!call) {
      return xml(ctx.res, 200, sayAndHangup("אירעה תקלה בזיהוי השיחה. יש לנסות שוב."));
    }

    appendTranscript(callSid, speech);
    const draft = JSON.parse(call.draft_json || "{}");

    // Twilio: אין כרגע קליטת הקשות (dtmf) מוגדרת ב-<Gather> הרגיל (זיהוי דיבור), לכן אין תמיכה
    // ב"הקישו סולמית" בערוץ הזה בשלבים רגילים - ר' הערה מפורטת ב-services/yemot.js למה זה קיים רק
    // בימות. **חריג**: שלבי קוד PIN (DIGIT_ENTRY_STATES) כן משתמשים ב-<Gather> ייעודי במצב dtmf בלבד.
    const result = call.user_id
      ? await advance(call.state, speech, draft, db.prepare("SELECT * FROM users WHERE id = ?").get(call.user_id))
      : await advanceSignup(call.state, speech, draft);

    upsertCall(callSid, result.newUserId || call.user_id, result.nextState, result.draft || draft, result.outcome);
    if (result.hangup) {
      return xml(ctx.res, 200, sayAndHangup(result.text));
    }
    if (DIGIT_ENTRY_STATES.has(result.nextState)) {
      return xml(ctx.res, 200, sayAndGatherDigits({ text: result.text, actionPath: "/api/ivr/handle", numDigits: 4 }));
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
  // opts.menuVoiceOnly: true - כשזיהוי דיבור משודרג (Whisper) פעיל גם בתפריט הראשי (ר' routes/yemot.js),
  // התפריט עובר למצב "הקלטה" גולמי כדי לתמלל במדויק - ובמצב הזה הקשת מקלדת **לא נקלטת בכלל** תוך כדי
  // ההקלטה (בניגוד למצב הרגיל). לכן, במצב הזה בלבד, לא מזכירים למתקשר שאפשר להקיש - זה היה מטעה.
  const digitNote = opts.digitConfirm && !opts.menuVoiceOnly ? " אפשר גם להקיש 1 עד 6." : "";
  return `${name ? `שלום ${name}, ` : "שלום, "}הגעתם לפנקס שלי. נא לציין קטגוריה: ${mainMenuCategoriesText()}${digitNote}`;
}
function mainMenuCategoriesText() {
  return "ניהול חשבונות, תנועות, חונכות, מטפלים, הורה, או הערת מפקח.";
}

// אחרי כל פעולה שהושלמה (או הודעת מידע/שגיאה סופית כמו "אין מפגש פתוח") - במקום לנתק מיד את
// השיחה (כמו שהיה קודם בכל מקום), חוזרים לתפריט הראשי ושואלים אם יש עוד משהו לעשות. אפשר לסיים
// את השיחה בנימוס בכל רגע מהתפריט הראשי עצמו (ר' מילות המפתח "לסיים"/"תודה" וכו' ב-case "main_menu").
function askMoreOrFinish(baseText, outcome) {
  return { text: `${baseText} רוצים לעשות עוד משהו, או לסיים?`, nextState: "main_menu", hints: MAIN_MENU_HINTS, outcome };
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
      // אפשרות לסיים את השיחה בנימוס מהתפריט הראשי עצמו (למשל אחרי ששמעו יתרה וחוזרים לכאן,
      // ר' doBalance) - בלי זה, הדרך היחידה לסיים שיחה הייתה תמיד באמצע פעולה ספציפית (הוספת
      // הוצאה/הכנסה וכד'), ולא היה אפשר פשוט "לצאת" מהתפריט הראשי עצמו.
      if (includesAny(es, ["לסיים", "סיימתי", "תודה", "להתראות", "סיום", "לא תודה"])) {
        return { text: "תודה, להתראות.", nextState: "done", hangup: true, outcome: "menu_exit" };
      }
      if (includesAny(es, ["ניהול חשבונות", "חשבונות", "יתרה", "מצב חשבון"])) return doBalance(user);
      if (includesAny(es, ["הוצאה", "הוצאות"])) return { text: "כמה עלה? אפשר לומר סכום בשקלים.", nextState: "expense_amount" };
      if (includesAny(es, ["הכנסה", "הכנסות"])) return { text: "מה סכום ההכנסה?", nextState: "income_amount" };
      if (includesAny(es, ["תנועות", "תנועה"])) return { text: transactionsTypePrompt(opts), nextState: "transactions_pick_type" };
      if (includesAny(es, ["חונכות", "תלמיד"])) return { text: "מה שם התלמיד?", nextState: "mentor_pick_student" };
      if (includesAny(es, ["מטפלים", "מטפל", "דיווח", "ריפוי", "רגשי"])) return { text: "מה סוג הדיווח: ריפוי בעיסוק, טיפול רגשי, או אחר?", nextState: "therapist_role" };
      if (includesAny(es, ["הורה", "הורים"])) return startGuardianFlow(user);
      if (includesAny(es, ["מפקח", "הערת מפקח", "הערה"])) return { text: "על איזה תלמיד ההערה?", nextState: "supervisor_pick_student" };
      return { text: `לא הבנתי.${retryHint()} אפשר לומר: ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
    }

    // ---------- תנועות: בחירת סוג (הכנסה/הוצאה) ----------
    case "transactions_pick_type": {
      const digit = onlyDigits(s);
      if (digit === "2" || includesAny(s, ["הוצאה"])) return { text: "כמה עלה? אפשר לומר סכום בשקלים.", nextState: "expense_amount" };
      if (digit === "1" || includesAny(s, ["הכנסה"])) return { text: "מה סכום ההכנסה?", nextState: "income_amount" };
      return { text: `לא הבנתי.${retryHint()} הכנסה או הוצאה?`, nextState: "transactions_pick_type" };
    }

    // ---------- הוצאה ----------
    case "expense_amount": {
      const amount = extractAmount(s);
      if (!amount) return { text: `לא זיהיתי סכום.${retryHint()} כמה עלה, בשקלים?`, nextState: "expense_amount" };
      // חוזרים מיד על הסכום שזוהה (לפני שממשיכים לשאלה הבאה) - כדי לתפוס מיד טעות זיהוי בסכום
      // (מספרים מועדים לטעויות זיהוי דיבור), במקום לחכות לאישור הסופי כמה שאלות אחר כך.
      return { text: `רשמתי ${amount} שקלים. לאיזו קטגוריה? למשל: מזון, תחבורה, דיור, אחר.`, nextState: "expense_category", draft: { amount } };
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
      // חשוב: לא "כל מה שאינו כן = לא/ביטול" - זה היה מבטל שקט את כל התנועה אם זיהוי הדיבור פשוט
      // לא הבין את המילה (למשל "אישור" שלפעמים לא מזוהה, ר' isConfirmYes). מבטלים רק ב"לא" מפורש,
      // ובכל קלט לא ברור אחר שואלים שוב את אותה שאלה במקום למחוק את מה שהמשתמש כבר הזין.
      if (isConfirmYes(s, opts)) {
        db.prepare("INSERT INTO transactions (user_id, type, amount, category, source) VALUES (?, 'expense', ?, ?, 'phone')")
          .run(user.id, draft.amount, draft.category);
        return askMoreOrFinish(`נשמר. הוצאה של ${draft.amount} שקלים ב${draft.category}.`, "expense_saved");
      }
      if (isConfirmNo(s, opts)) return { text: `בוטל. אפשר להתחיל שוב, מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      return {
        text: `לא הבנתי.${retryHint()} לאשר: הוצאה של ${draft.amount} שקלים בקטגוריית ${draft.category}? אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "expense_confirm",
        draft,
      };
    }

    // ---------- הכנסה ----------
    case "income_amount": {
      const amount = extractAmount(s);
      if (!amount) return { text: `לא זיהיתי סכום.${retryHint()} מה סכום ההכנסה?`, nextState: "income_amount" };
      return { text: `לאשר: הכנסה של ${amount} שקלים? אמרו כן לאישור.${confirmSuffix(opts)}`, nextState: "income_confirm", draft: { amount } };
    }
    case "income_confirm": {
      // ר' הערה ב-expense_confirm - אותו עיקרון: מבטלים רק ב"לא" מפורש, לא בכל קלט לא ברור.
      if (isConfirmYes(s, opts)) {
        db.prepare("INSERT INTO transactions (user_id, type, amount, source) VALUES (?, 'income', ?, 'phone')").run(user.id, draft.amount);
        return askMoreOrFinish(`נשמר. הכנסה של ${draft.amount} שקלים.`, "income_saved");
      }
      if (isConfirmNo(s, opts)) return { text: `בוטל. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      return {
        text: `לא הבנתי.${retryHint()} לאשר: הכנסה של ${draft.amount} שקלים? אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "income_confirm",
        draft,
      };
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
      if (!spokenName) return { text: `לא שמעתי שם.${retryHint()} מה שם התלמיד?`, nextState: "mentor_pick_student" };
      return {
        text: `לא מצאתי תלמיד בשם ${spokenName} ברשימת התלמידים שלך. רוצים להוסיף אותו כתלמיד חדש?${addStudentDigitsNote(opts)}`,
        nextState: "mentor_confirm_add_student",
        draft: { pendingStudentName: spokenName },
      };
    }
    case "mentor_confirm_add_student": {
      const digit = onlyDigits(s);
      // תוקן (אבחון בפועל מול קו אמיתי): "להוסיף" (צורת המקור/עתיד, "אני רוצה להוסיף") היה חסר מרשימת
      // מילות המפתח - היו רק "הוסף"/"הוסיפו" (ציווי). מי שענה על השאלה "רוצים להוסיף אותו כתלמיד חדש?"
      // באופן טבעי ביותר בעברית ("כן, להוסיף") לא זוהה בכלל כאישור, ונפל בטעות למסלול "מנסים שוב כאילו
      // זה שם תלמיד" (השורות למטה) - כלומר המערכת "חשבה" שהמילה "להוסיף" היא ניסיון נוסף לומר שם.
      const wantsAdd = digit === "1" || includesAny(s, ["כן", "אישור", "מאשר", "לאשר", "מאושר", "הוסיפו", "הוסף", "להוסיף"]);
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
      if (!retryName) return { text: `לא שמעתי שם.${retryHint()} מה שם התלמיד?`, nextState: "mentor_pick_student" };
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
      // "מפגש" נכלל כאן בנוסף ל"רגיל"/"מהיר"/"קבוע" - בבדיקה בפועל זיהוי הדיבור לפעמים קלט רק את המילה
      // הראשונה מתוך "מפגש רגיל" (שתי מילים) והשמיט את השנייה, אז בלי "מפגש" עצמו ברשימה זה לא היה מזוהה בכלל.
      if (digit === "3" || includesAny(s, ["רגיל", "מהיר", "קבוע", "מפגש"])) return doQuickSession(draft, user);
      if (digit === "4" || includesAny(s, ["הסר", "הסרה", "להסיר", "מחיקה", "מחק", "לא לומד", "הפסיק"])) {
        return {
          text: `לאשר: להסיר את ${draft.studentName} מרשימת התלמידים שלך? התלמיד לא יימחק לצמיתות, רק לא יופיע יותר ברשימה הפעילה - כל ההיסטוריה שלו נשארת בתיק. אמרו כן לאישור.${confirmSuffix(opts)}`,
          nextState: "mentor_remove_confirm",
          draft,
        };
      }
      return { text: `לא הבנתי.${retryHint()} ${mentorActionPrompt(draft.studentName, opts)}`, nextState: "mentor_action" };
    }
    case "mentor_remove_confirm": {
      // פעולה הרסנית (גם אם רק מחיקה רכה) - חשוב במיוחד כאן לא לבטל ולא לאשר על קלט לא ברור, רק
      // לשאול שוב. ר' הערה מפורטת יותר ב-expense_confirm.
      if (isConfirmYes(s, opts)) {
        db.prepare("UPDATE students SET active = 0 WHERE id = ? AND owner_user_id = ?").run(draft.studentId, user.id);
        return askMoreOrFinish(`${draft.studentName} הוסר/ה מרשימת התלמידים הפעילים שלך.`, "student_removed");
      }
      if (isConfirmNo(s, opts)) return { text: `בסדר, לא הסרנו. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      return {
        text: `לא הבנתי.${retryHint()} לאשר: להסיר את ${draft.studentName} מרשימת התלמידים שלך? התלמיד לא יימחק לצמיתות, רק לא יופיע יותר ברשימה הפעילה - כל ההיסטוריה שלו נשארת בתיק. אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "mentor_remove_confirm",
        draft,
      };
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
      if (!student) return { text: `לא מצאתי תלמיד בשם הזה.${retryHint()} אפשר לומר שוב?`, nextState: "therapist_student" };
      // חוזרים מיד על שם התלמיד שזוהה (בדיוק כמו mentorActionPrompt) - כדי שיהיה ברור מיד שהשם הובן נכון.
      return { text: `${student.name}. מה תוכן הדיווח? אפשר לתאר את ההתקדמות והמטרות.`, nextState: "therapist_note", draft: { ...draft, studentId: student.id, studentName: student.name } };
    }
    case "therapist_note": {
      return {
        text: `לאשר דיווח על ${draft.studentName}: ${speech}. אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "therapist_confirm",
        draft: { ...draft, note: speech },
      };
    }
    case "therapist_confirm": {
      // ר' הערה ב-expense_confirm - לא רוצים לאבד דיווח שלם (שנאמר במילים, אולי ארוך) רק כי המילה
      // "אישור"/"לאשר" עצמה לא זוהתה.
      if (isConfirmYes(s, opts)) {
        db.prepare(
          "INSERT INTO therapy_reports (student_id, professional_user_id, role_type, note, trend, transcript) VALUES (?, ?, ?, ?, 'יציבה', ?)"
        ).run(draft.studentId, user.id, draft.role, draft.note, draft.note);
        return askMoreOrFinish(`הדיווח נשמר עבור ${draft.studentName}.`, "report_saved");
      }
      if (isConfirmNo(s, opts)) return { text: `בוטל. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      return {
        text: `לא הבנתי.${retryHint()} לאשר דיווח על ${draft.studentName}: ${draft.note}. אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "therapist_confirm",
        draft,
      };
    }

    // ---------- הורה: סיכום קולי על הילד/ים ----------
    case "guardian_pick_child": {
      const options = draft.children || [];
      const match = options.find((c) => normalize(c.name).includes(s) || s.includes(normalize(c.name)));
      if (!match) return { text: `לא זיהיתי את השם.${retryHint()} אפשר לומר שוב את שם הילד?`, nextState: "guardian_pick_child" };
      return guardianSummaryResult(match);
    }

    // ---------- הערת מפקח ----------
    case "supervisor_pick_student": {
      const student = findStudentByName(null, s);
      if (!student) return { text: `לא מצאתי תלמיד בשם הזה.${retryHint()} אפשר לומר שוב?`, nextState: "supervisor_pick_student" };
      // חוזרים מיד על שם התלמיד שזוהה - כדי שיהיה ברור מיד שהשם הובן נכון.
      return { text: `${student.name}. מה תוכן ההערה?`, nextState: "supervisor_readback", draft: { studentId: student.id, studentName: student.name } };
    }
    case "supervisor_readback": {
      return {
        text: `לאשר הערה על ${draft.studentName}: ${speech}. אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "supervisor_confirm",
        draft: { ...draft, text: speech },
      };
    }
    case "supervisor_confirm": {
      // ר' הערה ב-expense_confirm.
      if (isConfirmYes(s, opts)) {
        db.prepare("INSERT INTO student_comments (student_id, author_user_id, author_label, text) VALUES (?, ?, ?, ?)")
          .run(draft.studentId, user.id, `${user.full_name} (דרך השיחה הקולית)`, draft.text);
        return askMoreOrFinish(`ההערה נשמרה בתיק ${draft.studentName}.`, "comment_saved");
      }
      if (isConfirmNo(s, opts)) return { text: `בוטל. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      return {
        text: `לא הבנתי.${retryHint()} לאשר הערה על ${draft.studentName}: ${draft.text}. אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "supervisor_confirm",
        draft,
      };
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
      if (!fullName) return { text: `לא שמעתי שם.${retryHint()} מה השם המלא שלכם?`, nextState: "signup_name" };
      return {
        text: `לאשר: נרשמים בשם ${fullName}, עם מספר הטלפון שממנו אתם מתקשרים כרגע? אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "signup_confirm",
        draft: { ...draft, fullName },
      };
    }
    // תיקון בטיחות (אותו דפוס שהופעל כבר בכל שאר צמתי האישור - ר' expense_confirm וכו' ב-advance()):
    // בעבר כל קלט לא ברור כאן (למשל זיהוי דיבור שגוי) נחשב אוטומטית "לא", ומחק בשקט את השם שכבר
    // נאמר וחזר להתחיל את ההרשמה מההתחלה ("מה השם המלא שלכם?") - מתסכל ומיותר אם זו רק אי-הבנה
    // חד-פעמית. עכשיו: "כן" מפורש -> ממשיכים; "לא" מפורש -> באמת מתחילים מחדש; כל השאר -> חוזרים
    // על אותה שאלת אישור (עם השם שכבר נאמר עדיין שמור), בלי לאבד כלום.
    case "signup_confirm": {
      if (isConfirmYes(s, opts)) {
        return {
          text: "עכשיו נגדיר קוד סודי בן 4 ספרות - הוא ישמש גם לכניסה לאתר בעתיד. הקישו עכשיו 4 ספרות במקלדת הטלפון.",
          nextState: "signup_pin",
          draft,
        };
      }
      if (isConfirmNo(s, opts)) {
        return { text: "בסדר, ננסה שוב. מה השם המלא שלכם?", nextState: "signup_name", draft: { phone: draft.phone } };
      }
      return {
        text: `לא הבנתי.${retryHint()} לאשר: נרשמים בשם ${draft.fullName}, עם מספר הטלפון שממנו אתם מתקשרים כרגע? אמרו כן לאישור.${confirmSuffix(opts)}`,
        nextState: "signup_confirm",
        draft,
      };
    }
    // קוד PIN בן 4 ספרות - נקבע דרך הקשת מקלדת בלבד (לא דיבור, ר' DIGIT_ENTRY_STATES/sayAndGatherDigits
    // ב-routes/ivr.js ו-routes/yemot.js), ומשמש גם כסיסמה להתחברות באתר (ר' isValidPin ב-utils/crypto.js
    // - אותה סיסמה בדיוק עובדת משני הכיוונים). מבקשים הקשה כפולה (כמו הגדרת PIN בכספומט) כדי לתפוס
    // הקשה שגויה בטעות, לפני שהחשבון בכלל נוצר.
    // "התקבל"/"הוגדר בהצלחה" בתחילת המשפט הבא בכוונה מפורשת: יש עיכוב טבעי (זמן תקשורת ברשת) בין
    // סיום ההקשה לבין שהמערכת עונה - בלי מילת אישור ברורה בתחילת המשפט הבא, המתקשר לא יודע אם
    // ההקשה בכלל "נקלטה" תוך כדי ההמתנה השקטה. מילה ראשונה שמאשרת קליטה בבירור פותרת את זה.
    case "signup_pin": {
      const digits = onlyDigits(speech);
      if (!digits || digits.length !== 4) {
        return { text: `לא קלטתי בדיוק 4 ספרות.${retryHint()} הקישו שוב 4 ספרות במקלדת הטלפון לקוד הסודי.`, nextState: "signup_pin", draft };
      }
      return {
        text: "התקבל. עכשיו הקישו שוב את אותן 4 הספרות, לאישור.",
        nextState: "signup_pin_confirm",
        draft: { ...draft, pendingPin: digits },
      };
    }
    case "signup_pin_confirm": {
      const digits = onlyDigits(speech);
      if (digits && digits.length === 4 && digits === draft.pendingPin) {
        return {
          text: "הקוד הוגדר בהצלחה. אפשר גם לצרף כתובת מייל לחשבון, זה לא חובה - אין צורך לדבר, רק הקישו: 1 לכתובת ג'ימייל, 2 לכתובת אאוטלוק, או 0 להמשך בלי מייל.",
          nextState: "signup_email",
          draft: { ...draft, pin: draft.pendingPin, pendingPin: undefined },
        };
      }
      return {
        text: "הספרות לא תאמו. ננסה שוב מההתחלה - הקישו 4 ספרות חדשות לקוד הסודי.",
        nextState: "signup_pin",
        draft: { ...draft, pendingPin: undefined },
      };
    }
    // תוקן (אבחון בפועל מול קו אמיתי - ר' README/yemot-support-question.md): בעבר ביקשנו מהמתקשר
    // לומר את כל כתובת המייל בקול (כולל "שטרודל"/"נקודה") - בבדיקה בפועל התברר שזה נכשל כמעט תמיד
    // ("לא זוהה דיבור"), כי הקראת סימנים כאלה בקול היא תוכן קשה במיוחד לזיהוי דיבור, בכל מנוע. התיקון:
    // בכלל לא מבקשים לדבר בשלב הזה - החלק הראשון של הכתובת (לפני השטרודל) נבנה אוטומטית מהשם המלא
    // שכבר נאמר בהצלחה קודם בשיחה (ר' buildEmailLocalPart), והספק (gmail/outlook) נבחר בהקשת ספרה
    // בלבד (אמינה כמעט תמיד, בניגוד לזיהוי דיבור) - כך שלא צריך לבטא שום סימן בקול בכלל.
    case "signup_email": {
      const digit = onlyDigits(s);
      const wantsGmail = digit === "1" || includesAny(s, ["גימייל", "גימיל", "ג'ימייל"]);
      const wantsOutlook = digit === "2" || includesAny(s, ["אאוטלוק", "אוטלוק"]);
      const domain = wantsGmail ? "gmail.com" : wantsOutlook ? "outlook.com" : null;

      // גם 0/"דלג" מפורש, וגם כל קלט אחר לא ברור (למשל "לא זוהה דיבור" שלא הגיע אלינו בכלל, או מילה
      // לא מזוהה) - פשוט ממשיכים בלי מייל, לא תוקעים בלולאה (מייל ממילא לא חובה, אפשר להוסיף באתר).
      if (!domain) {
        const newUser = createPhoneUser(draft.fullName, draft.phone, null, draft.pin);
        return {
          text: `נרשמת בהצלחה! ${mainMenuPrompt(newUser.full_name, opts)}`,
          nextState: "main_menu",
          newUserId: newUser.id,
          hints: MAIN_MENU_HINTS,
          outcome: "phone_signup_completed",
        };
      }

      const localPart = buildEmailLocalPart(draft.fullName);
      const email = localPart ? `${localPart}@${domain}` : null;
      const newUser = createPhoneUser(draft.fullName, draft.phone, email, draft.pin);
      const emailNote = email ? `נשמרה גם כתובת המייל ${email} (אפשר לשנות אותה מאוחר יותר באתר). ` : "";
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

// טבלת תעתיק גס (עיצורים בעיקר, עם ניחוש סביר לתנועות ע"י ו/י) מעברית ללטינית - נועדה לבנות חלק
// ראשון סביר לכתובת מייל (לפני השטרודל) מתוך השם המלא שכבר נאמר ונקלט בהצלחה קודם בשיחה, בלי לבקש
// מהמתקשר לבטא שום דבר נוסף בקול. לא מדויקת מבחינה בלשנית (עברית כתובה לא כוללת את כל התנועות) - אבל
// זה בסדר: המטרה היא כתובת ASCII סבירה וייחודית, לא תעתיק מושלם - אפשר תמיד לתקן אותה אח"כ באתר.
const HEBREW_TO_LATIN = {
  א: "a", ב: "b", ג: "g", ד: "d", ה: "h", ו: "v", ז: "z", ח: "ch", ט: "t",
  י: "i", כ: "k", ך: "k", ל: "l", מ: "m", ם: "m", נ: "n", ן: "n", ס: "s",
  ע: "a", פ: "p", ף: "f", צ: "tz", ץ: "tz", ק: "k", ר: "r", ש: "sh", ת: "t",
};
function buildEmailLocalPart(fullName) {
  const transliterated = String(fullName || "")
    .trim()
    .toLowerCase()
    .split("")
    .map(ch => HEBREW_TO_LATIN[ch] ?? ch)
    .join("");
  const local = transliterated
    .replace(/[^a-z0-9\s._-]/g, "")
    .trim()
    .replace(/\s+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return local || null;
}

// יוצר משתמש חדש ישירות מתוך שיחת טלפון. הזיהוי בשיחות הבאות תמיד לפי Caller ID, לא סיסמה - אבל
// pin (קוד בן 4 ספרות שהוקש בשלב signup_pin/signup_pin_confirm) נשמר כסיסמה בפועל, כדי לאפשר גם
// כניסה לאתר (ר' isValidPin ב-utils/crypto.js - אותה סיסמה בדיוק, בלי שדה נפרד). אם מסיבה כלשהי
// לא התקבל pin תקין (לדוגמה נתיב ישן/בדיקה) - נופלים בחזרה לסיסמה אקראית לא ידועה, כמו קודם, כדי
// שלא ליצור משתמש בלי סיסמה בכלל.
function createPhoneUser(fullName, phone, email, pin) {
  const digits = String(phone || "").replace(/\D/g, "").slice(-9) || "user";
  let username = `phone_${digits}`;
  let n = 1;
  while (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
    n++;
    username = `phone_${digits}_${n}`;
  }
  const randomPassword = crypto.randomBytes(16).toString("hex");
  const passwordToUse = isValidPin(pin) ? pin : randomPassword;
  // signup_channel='phone' בכוונה מפורשת - חשבון שנוצר כך לא כשיר להיות "בעל הקו" (ר'
  // /api/me/request-admin-claim ב-routes/auth.js), גם אם יש לו עכשיו סיסמה/PIN ידוע - זה נשאר תלוי
  // בערוץ ההרשמה המקורי (web בלבד), לא רק בשאלה אם יש סיסמה ידועה.
  const info = db
    .prepare("INSERT INTO users (full_name, username, password_hash, phone, email, roles, signup_channel) VALUES (?, ?, ?, ?, ?, 'private', 'phone')")
    .run(fullName, username, hashPassword(passwordToUse), phone || null, email || null);
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
  return askMoreOrFinish(`היתרה הנוכחית שלך היא ${balance} שקלים.`, "balance_read");
}

function doCheckin(draft) {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(draft.studentId);
  if (student.checkin_at) return askMoreOrFinish("כבר קיים מפגש פתוח לתלמיד הזה.");
  db.prepare("UPDATE students SET checkin_at = datetime('now') WHERE id = ?").run(student.id);
  return askMoreOrFinish(`נרשמה כניסה עבור ${student.name}.`, "checkin_saved");
}

function doCheckout(draft, user) {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(draft.studentId);
  if (!student.checkin_at) return askMoreOrFinish("אין מפגש פתוח לתלמיד הזה.");
  const start = new Date(student.checkin_at + "Z");
  const durationMinutes = Math.max(1, Math.round((Date.now() - start.getTime()) / 60000));
  db.prepare("INSERT INTO sessions (student_id, mentor_user_id, method, duration_minutes) VALUES (?, ?, 'checkin_checkout', ?)")
    .run(student.id, user.id, durationMinutes);
  db.prepare("UPDATE students SET checkin_at = NULL WHERE id = ?").run(student.id);
  return askMoreOrFinish(`נרשמה יציאה עבור ${student.name}. משך המפגש: ${durationMinutes} דקות.`, "checkout_saved");
}

function doQuickSession(draft, user) {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(draft.studentId);
  const u = db.prepare("SELECT default_session_minutes FROM users WHERE id = ?").get(user.id);
  const minutes = u.default_session_minutes || 45;
  db.prepare("INSERT INTO sessions (student_id, mentor_user_id, method, duration_minutes) VALUES (?, ?, 'quick_preset', ?)")
    .run(student.id, user.id, minutes);
  return askMoreOrFinish(`נרשם מפגש עבור ${student.name}, ${minutes} דקות.`, "quick_session_saved");
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
    return askMoreOrFinish("לא נמצאו ילדים המשויכים אליך כהורה במערכת.", "guardian_no_children");
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
  return askMoreOrFinish(text, "guardian_summary_read");
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

// בודק אם תשובה נחשבת "כן" בצומת אישור: תמיד לפי מילה מדוברת ("כן"/"אישור"/"מאשר"/"לאשר"), ובערוצים
// שתומכים בהקשה תוך כדי זיהוי דיבור (opts.digitConfirm) - גם הקשת 1, כדי לאפשר אישור מהיר בלי לחכות
// לעיבוד הדיבור. בעבר קיבלנו כאן כל הקשת ספרה (כולל סולמית בודדת) כ"כן" - התברר בבדיקה בפועל שסולמית
// בודדת (בלי ספרה לפניה) לרוב לא מגיעה בכלל לשרת שלנו במצב זיהוי דיבור של ימות (ככל הנראה נבלעת
// כתו סיום קלט), ומצד שני קבלת *כל* ספרה כ"כן" הייתה מסוכנת (למשל הקשה בטעות של 2 באישור הסרת
// תלמיד הייתה מוחקת אותו בלי כוונה) - לכן עברנו ספציפית ל-1, שכבר מוכח כעובד באמינות בכל שאר התפריטים.
function isConfirmYes(s, opts) {
  if (includesAny(s, ["כן", "אישור", "מאשר", "לאשר", "מאושר"])) return true;
  if (opts && opts.digitConfirm) {
    const trimmed = String(s || "").trim();
    return onlyDigits(trimmed) === "1" || trimmed === "#";
  }
  return false;
}

// בודק אם תשובה נחשבת במפורש "לא" בצומת אישור - מילה מדוברת, או הקשת 2 (עקבי עם שאר התפריטים בהם
// 2 הוא תמיד "לא"/ביטול). חשוב: זה **לא** סתם "לא isConfirmYes" - ר' ההערה בכל צומת אישור למה.
function isConfirmNo(s, opts) {
  if (includesAny(s, ["לא", "ביטול", "בטל"])) return true;
  if (opts && opts.digitConfirm) return onlyDigits(String(s || "").trim()) === "2";
  return false;
}

// טקסט נוסף שמצטרף לשאלות אישור בערוצים שתומכים בהקשה (ר' isConfirmYes) - מציע הקשת 1, לא סולמית
// (סולמית בודדת התבררה כלא אמינה במצב זיהוי דיבור של ימות - ר' isConfirmYes)
function confirmSuffix(opts) {
  return opts && opts.digitConfirm ? " אפשר גם להקיש 1 לאישור מהיר." : "";
}

// טקסט שמצטרף לכל הודעת "לא הבנתי"/"לא שמעתי" - בבדיקה בפועל מול ימות מתברר שלפעמים אותה מילה
// לא מזוהה, אבל ניסוח מעט שונה שלה כן (למשל "יוסי" זוהה כשר "יוסף" לא) - אז כדאי לרמוז למתקשר לנסות
// לומר את זה קצת אחרת, לא רק לחזור בדיוק על אותה מילה.
function retryHint() {
  return " אם זה לא מזוהה, כדאי לנסות לומר את זה בצורה קצת שונה.";
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
  OPENING_GREETING,
  DIGIT_ENTRY_STATES,
};
