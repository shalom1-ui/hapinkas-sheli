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
const { rememberPhrase, getDictionary } = require("../lib/dictionary");

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

// צמתי "אישור/שינוי/ביטול" משולשים (ר' wantsMenuChange/wantsMenuCancel/confirmMenuText למטה) -
// בערוצים שתומכים בהקשה (ימות, ר' routes/yemot.js) עוברים למצב הקשה טהור (tap, בדיוק כמו קוד
// PIN - ר' DIGIT_ENTRY_STATES) כדי לחסוך את זמן ההמתנה לזיהוי דיבור/עיבוד קול לגמרי - משוב אמיתי
// ממשתמש על שקט מיותר בין שלב לשלב, ובקשה מפורשת ש"האישורים יהיו על המקשים לא בזיהוי דיבור".
// לא כולל mentor_note_offer/mentor_confirm_add_student/signup_email_offer/signup_email_retry -
// אלה כן/לא (או תפריט קצר) "רגילים" עם קיצור הקשה קיים כבר, לא חלק מהמודל המשולש הזה.
const CONFIRM_MENU_STATES = new Set([
  "expense_confirm", "income_confirm", "mentor_remove_confirm", "mentor_note_confirm",
  "therapist_confirm", "supervisor_confirm", "signup_email_confirm", "lesson_prep_confirm",
]);

// תפריטי-הקשה קבועים נוספים (לא "אישור/שינוי/ביטול" - תפריט בחירה עם כמה אפשרויות ממוספרות) -
// אותו מנגנון פרוטוקול בדיוק כמו CONFIRM_MENU_STATES (מצב tap, ספרה אחת, ר' routes/yemot.js),
// רק סמנטיקת הספרות שונה לכל צומת (ר' EXPENSE_CATEGORY_DIGITS למטה). expense_category - משוב אמיתי
// ("לסדר בקטגוריות... רק עם הקשות"). ה-lesson_prep_*_pick נוספו בעקבות אותו עקרון - בחירת ניסוח
// קודם מה"מילון" (ר' LESSON_PREP_FIELDS/handleLessonFieldPick למטה) היא גם היא תפריט הקשה טהור.
const DIGIT_MENU_STATES = new Set([
  "expense_category", "lesson_prep_topic_studied_pick", "lesson_prep_goal_pick",
  "lesson_prep_practical_application_pick", "lesson_prep_connection_cooperation_pick",
]);

// שדות טופס "הכנה לשיעור" הנתמכים בטלפון. במקור רק עד לחלק שנקרא באתר "פרטים נוספים"
// (LESSON_FIELDS_BASIC ב-public/app.html) - אחר כך נוסף גם "שיתוף פעולה" (connection_cooperation,
// שדה קיים בטופס המלא תחת "פרטים נוספים" שם - "התחברות ושיתוף פעולה" - כאן נשאלת רק על שיתוף הפעולה,
// אבל נשמרת לאותה עמודה בדיוק) - משוב אמיתי מפורש שביקש להוסיף אותו בחזרה. dictKind תואם בדיוק
// לפורמט kind ב-phrase_dictionary (ר' routes/lessonReports.js, "lesson_" + שם השדה) - כך שניסוח
// שהוכתב בטלפון מוצע גם באתר בפעם הבאה, ולהפך (אותו "מילון" בדיוק, משותף בין שני הערוצים).
const LESSON_PREP_FIELDS = [
  { id: "topic_studied", label: "הקטע שנלמד", question: "מה הקטע שנלמד בשיעור?", dictKind: "lesson_topic_studied" },
  { id: "goal", label: "המטרה", question: "מה הייתה מטרת השיעור?", dictKind: "lesson_goal" },
  { id: "practical_application", label: "היישום בפועל", question: "איך זה יושם בפועל בשיעור?", dictKind: "lesson_practical_application" },
  { id: "connection_cooperation", label: "שיתוף הפעולה", question: "איך היה שיתוף הפעולה של התלמיד בשיעור?", dictKind: "lesson_connection_cooperation" },
];
function lessonSpeakState(i) { return `lesson_prep_${LESSON_PREP_FIELDS[i].id}_speak`; }
function lessonRetryState(i) { return `lesson_prep_${LESSON_PREP_FIELDS[i].id}_retry`; }
function lessonPickState(i) { return `lesson_prep_${LESSON_PREP_FIELDS[i].id}_pick`; }
function lessonFieldIndexFromState(state) {
  return LESSON_PREP_FIELDS.findIndex((f) => state.startsWith(`lesson_prep_${f.id}_`));
}

// שלב הכתבה חופשית לשדה (Whisper/מנוע ההקלטה הרגיל, ר' FREE_TEXT_STATES ב-routes/yemot.js) - אם
// נשמע משהו, ממשיכים לשדה הבא (או לאישור הסופי אם זה האחרון); אם לא נשמע כלום, לא חוזרים ישר לעוד
// ניסיון הקלטה (ר' lessonRetryState) - מציעים גם לבחור מתוך ניסוחים קודמים בהקשה, במקום לנסות שוב
// ושוב בקול בלי הצלחה (משוב אמיתי: "אם הוא מנסה ולא הולך").
function handleLessonFieldSpeak(fieldIndex, speech, draft, opts) {
  const field = LESSON_PREP_FIELDS[fieldIndex];
  const trimmed = String(speech || "").trim();
  if (!trimmed) {
    return {
      text: `לא שמעתי. אפשר לנסות שוב לתאר בקול, או להקיש 1 לבחור מתוך ניסוחים קודמים שלכם בהקשה. ${field.question}`,
      nextState: lessonRetryState(fieldIndex),
      draft,
    };
  }
  const lessonPrep = { ...(draft.lessonPrep || {}), [field.id]: trimmed };
  const nextIndex = fieldIndex + 1;
  if (nextIndex < LESSON_PREP_FIELDS.length) {
    return { text: LESSON_PREP_FIELDS[nextIndex].question, nextState: lessonSpeakState(nextIndex), draft: { ...draft, lessonPrep } };
  }
  return { text: lessonPrepConfirmText({ ...draft, lessonPrep }, opts), nextState: "lesson_prep_confirm", draft: { ...draft, lessonPrep } };
}

// שלב "לא שמעתי כלום" - כן/לא רגיל (לא Whisper) עם קיצור הקשה 1 אמין: 1 = לבחור מתוך ה"מילון" בהקשה,
// כל קלט אחר = לנסות שוב לתאר בקול. לא digitConfirm-tap טהור בכוונה (בניגוד ל-lesson_prep_*_pick) -
// כדי שאפשר יהיה גם פשוט להתחיל לדבר ישירות מכאן בלי להקיש כלום קודם, אם המתקשר מעדיף.
function handleLessonFieldRetry(fieldIndex, s, draft) {
  const digit = singleDigitPress(s);
  const field = LESSON_PREP_FIELDS[fieldIndex];
  if (digit === "1" || includesAny(s, ["בחירה", "לבחור", "רשימה", "ניסוחים"])) {
    const phrases = getDictionary(draft.mentorUserId, field.dictKind).slice(0, 5);
    if (!phrases.length) {
      return { text: `אין עדיין ניסוחים שמורים לשדה הזה, ננסה בקול. ${field.question}`, nextState: lessonSpeakState(fieldIndex), draft };
    }
    // "1) ..." ולא "1. ..." בכוונה - נקודה נמחקת ע"י sanitizeForYemot (ר' services/yemot.js), אז
    // "1. חיבור" היה נשמע/מוצג בפועל כ"1 חיבור" בלי שום הפרדה ברורה בין המספר לתחילת הניסוח.
    const listText = phrases.map((p, idx) => `${idx + 1}) ${p}`).join(", ");
    return {
      text: `הניסוחים הקודמים שלכם: ${listText}. הקישו את המספר המתאים.`,
      nextState: lessonPickState(fieldIndex),
      draft: { ...draft, lessonPickOptions: phrases },
    };
  }
  return { text: field.question, nextState: lessonSpeakState(fieldIndex), draft };
}

// בחירה מתוך ה"מילון" בהקשה טהור (ר' DIGIT_MENU_STATES) - הספרה היא אינדקס ברשימה שהוקראה
// (lessonPickOptions בדראפט, לא לפי dictKind מחדש - כדי שהבחירה תהיה בדיוק מה שהוקרא, גם אם המילון
// השתנה בינתיים תיאורטית).
function handleLessonFieldPick(fieldIndex, s, draft, opts) {
  const digit = singleDigitPress(s);
  const options = draft.lessonPickOptions || [];
  const idx = digit ? parseInt(digit, 10) - 1 : -1;
  const field = LESSON_PREP_FIELDS[fieldIndex];
  if (idx >= 0 && idx < options.length) {
    const lessonPrep = { ...(draft.lessonPrep || {}), [field.id]: options[idx] };
    const nextIndex = fieldIndex + 1;
    if (nextIndex < LESSON_PREP_FIELDS.length) {
      return {
        text: LESSON_PREP_FIELDS[nextIndex].question,
        nextState: lessonSpeakState(nextIndex),
        draft: { ...draft, lessonPrep, lessonPickOptions: undefined },
      };
    }
    return {
      text: lessonPrepConfirmText({ ...draft, lessonPrep }, opts),
      nextState: "lesson_prep_confirm",
      draft: { ...draft, lessonPrep, lessonPickOptions: undefined },
    };
  }
  return { text: `לא הבנתי את הבחירה. ${field.question}`, nextState: lessonSpeakState(fieldIndex), draft: { ...draft, lessonPickOptions: undefined } };
}

// טקסט האישור הסופי - מרכז את שלושת השדות שנאספו (או "לא צוין" לשדה שדולג עליו, אם היה כזה).
function lessonPrepConfirmText(draft, opts) {
  const lp = draft.lessonPrep || {};
  const parts = LESSON_PREP_FIELDS.map((f) => `${f.label}: ${lp[f.id] || "לא צוין"}`).join(", ");
  return `לאשר את טופס ההכנה לשיעור - ${parts}? ${confirmMenuText(opts)}`;
}

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
// תוקן (אבחון בפועל מול קו אמיתי): פסיקים בלבד בין הקטגוריות לא יצרו הפרדה קולית מספיקה אצל מנוע
// ה-TTS של ימות - "תנועות, חונכות" נשמע כמו ביטוי אחד מחובר ("תנועות חונכות"), לא כשתי קטגוריות
// נפרדות. אי אפשר לתקן את זה עם נקודות (תווי בקרה בפרוטוקול של ימות - ר' sanitizeForYemot, נמחקים
// אוטומטית). הפתרון: מוסיפים את המילה "או" לפני **כל** קטגוריה (לא רק לפני האחרונה) - כך שיש תמיד
// גבול מילה ברור בין קטגוריה לקטגוריה, בלי תלות בפרשנות של ימות לפיסוק.
function mainMenuCategoriesText() {
  return "ניהול חשבונות, או תנועות, או חונכות, או מטפלים, או הורה, או הערת מפקח.";
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
  const digits = singleDigitPress(s);
  return digits && MAIN_MENU_DIGIT_KEYWORDS[digits] ? normalize(MAIN_MENU_DIGIT_KEYWORDS[digits]) : null;
}
// שולף ספרות בלבד מתוך קלט (כולל כשמעורבת בו גם סולמית) - מחזיר null אם אין ספרות בכלל
function onlyDigits(s) {
  const digits = String(s || "").replace(/[^0-9]/g, "");
  return digits || null;
}

// תוקן (באג אמיתי שהתגלה בבדיקה חיה בפועל, גרם ליצירת תלמיד עם השם המילולי "Digits-11"!): ימות
// לפעמים מדווחת על הקשה כפולה/ממושכת של אותה ספרה כמחרוזת חוזרת (למשל "Digits-11" כשהמתקשר הקיש
// 1 פעמיים, לא "Digits-1" רגיל) - onlyDigits לבד היה מחזיר "11" במקרה כזה, שלא תואם בהשוואה מדויקת
// ל-"1"/"2"/"3" באף אחד מהצמתים - והקלט היה "נופל" בטעות למסלול טיפול אחר (למשל נחשב כניסיון לומר
// שם, ר' case "mentor_confirm_add_student"). הפונקציה הזו סולחת על הקשות כפולות של **אותה** ספרה
// (מחזירה "1" גם עבור "11"/"111") - אבל **לא** על רצף ספרות שונות (למשל "12" נשאר לא תואם, כדי לא
// להתבלבל עם קלט אמיתי אחר, כמו קוד PIN, שלא עובר דרך הפונקציה הזו בכלל - ר' onlyDigits הרגילה).
function singleDigitPress(s) {
  const digits = onlyDigits(s);
  if (!digits) return null;
  return /^(\d)\1*$/.test(digits) ? digits[0] : null;
}

// זיהוי "שאריות" גולמיות של פרוטוקול ההקשה של ימות (כמו "Digits-11") שלא תואמות אף בחירת הקשה
// צפויה בצומת הנוכחי - כדי **לא** לתת להן ליפול בטעות למסלול "טקסט חופשי"/"שם" (בדיוק הבאג שיצר
// תלמיד עם השם "Digits-11"). לא מסתמך רק על onlyDigits (ששולף גם ספרות מתוך שם אמיתי כמו "אבי בן
// 5" תיאורטית) - בודק במפורש את התבנית המילולית "Digits" שימות עצמה שולחת עבור הקשות.
function looksLikeRawDigitsArtifact(s) {
  return /^digits[-\s]*\d*$/i.test(String(s || "").trim());
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

// תפריט קטגוריות הוצאה קבוע - משוב אמיתי ממשתמש ("לסדר בקטגוריות מזון/תחבורה... שיהיה רק עם
// הקשות, לא זיהוי דיבור"). בימות (opts.digitConfirm): עובר לגמרי למצב הקשה טהור (ר' DIGIT_MENU_STATES
// ב-routes/yemot.js, בדיוק כמו CONFIRM_MENU_STATES) - אין יותר המתנה לזיהוי דיבור בכלל בשלב הזה.
// ב-Twilio (אין הקשות מוגדרות שם) - עדיין אפשר לומר את שם הקטגוריה בקול (ר' case "expense_category"
// למטה, גיבוי שקיים במפורש). 7 = "אחר" (תיאור חופשי, ר' case "expense_category_other") - זו עדיין
// כן שלב טקסט חופשי, כי אין דרך "לנחש" קטגוריה מותאמת-אישית בהקשה.
const EXPENSE_CATEGORY_DIGITS = { "1": "מזון", "2": "תחבורה", "3": "דיור", "4": "בריאות", "5": "חינוך", "6": "ביגוד" };
function expenseCategoryMenuText(opts) {
  if (opts && opts.digitConfirm) {
    return "לאיזו קטגוריה? הקישו: 1 מזון, 2 תחבורה, 3 דיור, 4 בריאות, 5 חינוך, 6 ביגוד, 7 אחר.";
  }
  return "לאיזו קטגוריה? למשל: מזון, תחבורה, דיור, אחר.";
}

// מנסה להתאים קטגוריה בתפריט הראשי (כולל מילות סיום שיחה) - מחזיר null אם לא זוהתה אף קטגוריה,
// כדי שהקורא יחליט מה לעשות עם קלט לא מזוהה (הודעת "לא הבנתי" משלו). משותף גם לתפריט הראשי עצמו
// (case "main_menu") וגם לכל שלב אחר שרוצה "ליפול חזרה" לאותה התאמה - כרגע: balance_next_action,
// כדי שאפשר יהיה למשל לומר "חונכות" גם ישר אחרי קריאת יתרה, בלי לחזור קודם לתפריט הראשי במפורש.
function matchMainMenuCategory(es, opts, user) {
  // אפשרות לסיים את השיחה בנימוס מכל מקום שמריץ את ההתאמה הזו (למשל אחרי ששמעו יתרה וחוזרים לכאן,
  // ר' doBalance) - בלי זה, הדרך היחידה לסיים שיחה הייתה תמיד באמצע פעולה ספציפית (הוספת
  // הוצאה/הכנסה וכד'), ולא היה אפשר פשוט "לצאת" מהתפריט הראשי עצמו.
  if (includesAny(es, ["לסיים", "סיימתי", "תודה", "להתראות", "סיום", "לא תודה"])) {
    return { text: "תודה, להתראות.", nextState: "done", hangup: true, outcome: "menu_exit" };
  }
  if (includesAny(es, ["ניהול חשבונות", "חשבונות", "יתרה", "מצב חשבון"])) return doBalance(user);
  if (includesAny(es, ["הוצאה", "הוצאות"])) return { text: "כמה עלה? אפשר לומר סכום בשקלים.", nextState: "expense_amount" };
  if (includesAny(es, ["הכנסה", "הכנסות"])) return { text: "מה סכום ההכנסה?", nextState: "income_amount" };
  if (includesAny(es, ["תנועות", "תנועה"])) return { text: transactionsTypePrompt(opts), nextState: "transactions_pick_type" };
  if (includesAny(es, ["חונכות", "תלמיד"])) return startMentorFlow(user);
  if (includesAny(es, ["מטפלים", "מטפל", "דיווח", "ריפוי", "רגשי"])) return { text: "מה סוג הדיווח: ריפוי בעיסוק, טיפול רגשי, או אחר?", nextState: "therapist_role" };
  if (includesAny(es, ["הורה", "הורים"])) return startGuardianFlow(user);
  if (includesAny(es, ["מפקח", "הערת מפקח", "הערה"])) return { text: "על איזה תלמיד ההערה?", nextState: "supervisor_pick_student" };
  return null;
}

// ---------- מכונת המצבים ----------
// כל צומת מקבל (speech, draft, user, opts) ומחזיר { text, nextState, draft?, hints?, hangup?, outcome? }
// opts.digitConfirm: true בערוצים שתומכים בהקשת ספרות/סולמית תוך כדי זיהוי דיבור (כרגע: ימות בלבד -
// ר' services/yemot.js) - מוסיף אפשרות אישור מהירה בהקשה, בלי לחכות לזיהוי הדיבור על המילה "כן".
async function advance(state, speech, draft, user, opts = {}) {
  const s = normalize(speech);

  // כוכבית (*) - "חזרה לתפריט הראשי", זמינה מכל מקום בשיחה (בערוצים שתומכים בהקשה תוך כדי זיהוי
  // דיבור - כרגע ימות בלבד, ר' opts.digitConfirm). המכונה הזו לא שומרת היסטוריית מצבים, אז אין
  // "תפריט קודם" ספציפי לכל צומת - במקום זאת חוזרים תמיד לתפריט הראשי, באותה רוח בדיוק כמו ביטול
  // רגיל (ר' isConfirmNo) שכבר תמיד חוזר לשם. לא פעיל בתוך main_menu עצמו (אין לאן "לחזור" משם).
  // לא רלוונטי בשלבי טקסט חופשי מוקלט (ר' FREE_TEXT_STATES ב-routes/yemot.js) - שם ימות ממילא
  // חוסמת הקשה כלשהי תוך כדי ההקלטה עצמה (מגבלת ימות, לא קשור לתכונה הזו).
  if (opts.digitConfirm && s === "*" && state !== "main_menu") {
    return { text: `חוזרים לתפריט הראשי. ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
  }

  switch (state) {
    case "main_menu": {
      // אפשר להקיש ספרה (1-6) במקום לדבר - ר' MAIN_MENU_DIGIT_KEYWORDS. מתייחסים אליה כאילו נאמרה
      // מילת המפתח המתאימה, ומריצים דרך אותה לוגיקת התאמה כרגיל.
      const es = mainMenuDigitKeyword(s) || s;
      const match = matchMainMenuCategory(es, opts, user);
      if (match) return match;
      return { text: `לא הבנתי.${retryHint()} אפשר לומר: ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
    }

    // ---------- אחרי קריאת יתרה (ר' doBalance): הצעה להוסיף הכנסה/הוצאה ----------
    // תוקן (משוב אמיתי ממשתמש): "ניהול חשבונות" קרא רק את היתרה וחזר לתפריט הראשי הרגיל - המשתמש
    // ציפה (בדיוק כמו באתר) שישאל מיד אם להוסיף הכנסה/הוצאה, כולל קיצור הקשה ייעודי (1=הכנסה,
    // 2=הוצאה - **שונה** מהמיפוי הרגיל של 1/2 בתפריט הראשי, ר' MAIN_MENU_DIGIT_KEYWORDS, בדיוק כמו
    // ב-transactions_pick_type). כל שאר הקטגוריות (חונכות, תנועות וכו') וגם מילות הסיום עדיין
    // עובדות מכאן, דרך אותה matchMainMenuCategory משותפת עם main_menu - כדי לא לאבד גמישות.
    case "balance_next_action": {
      const digit = singleDigitPress(s);
      if (digit === "1" || includesAny(s, ["הכנסה", "הכנסות"])) return { text: "מה סכום ההכנסה?", nextState: "income_amount" };
      if (digit === "2" || includesAny(s, ["הוצאה", "הוצאות"])) return { text: "כמה עלה? אפשר לומר סכום בשקלים.", nextState: "expense_amount" };
      const es = mainMenuDigitKeyword(s) || s;
      const match = matchMainMenuCategory(es, opts, user);
      if (match) return match;
      return {
        text: `לא הבנתי.${retryHint()} רוצים להוסיף הכנסה או הוצאה, או לסיים? אפשר גם להקיש: 1 להכנסה, 2 להוצאה.`,
        nextState: "balance_next_action",
        hints: MAIN_MENU_HINTS,
      };
    }

    // ---------- תנועות: בחירת סוג (הכנסה/הוצאה) ----------
    case "transactions_pick_type": {
      const digit = singleDigitPress(s);
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
      return { text: `רשמתי ${amount} שקלים. ${expenseCategoryMenuText(opts)}`, nextState: "expense_category", draft: { amount } };
    }
    case "expense_category": {
      // תוקן (משוב אמיתי ממשתמש: "לסדר בקטגוריות מזון/תחבורה... רק עם הקשות") - זה כבר לא שלב
      // טקסט חופשי (הוסר מ-FREE_TEXT_STATES ב-routes/yemot.js): תפריט קבוע של 7 אפשרויות בהקשה
      // (ר' EXPENSE_CATEGORY_DIGITS למעלה). "אחר" (7) עדיין מוביל לתיאור חופשי בקול - ר' הערה קודמת
      // ב-git history למה "אחר" לא הופך להיות שם הקטגוריה המילולי בעצמו.
      const digit = singleDigitPress(s);
      if (digit && EXPENSE_CATEGORY_DIGITS[digit]) {
        const category = EXPENSE_CATEGORY_DIGITS[digit];
        return {
          text: `לאשר: הוצאה של ${draft.amount} שקלים בקטגוריית ${category}? ${confirmMenuText(opts)}`,
          nextState: "expense_confirm",
          draft: { ...draft, category },
        };
      }
      if (digit === "7" || s === "אחר" || s === "אחרת") {
        return {
          text: "אפשר לתאר במילים חופשיות לאיזו קטגוריה? למשל: תרופות, מתנות, תיקונים.",
          nextState: "expense_category_other",
          draft,
        };
      }
      // גיבוי ל-Twilio בלבד (אין שם הקשות מוגדרות) - עדיין אפשר לומר את שם הקטגוריה בקול ישירות,
      // בלי לעבור דרך התפריט הממוספר. בימות (digitConfirm) זה לא מגיע לכאן כי הערוץ במצב הקשה טהור.
      if (!(opts && opts.digitConfirm)) {
        const spoken = String(speech || "").trim();
        if (spoken) {
          return {
            text: `לאשר: הוצאה של ${draft.amount} שקלים בקטגוריית ${spoken}? ${confirmMenuText(opts)}`,
            nextState: "expense_confirm",
            draft: { ...draft, category: spoken },
          };
        }
      }
      return { text: `לא הבנתי.${retryHint()} ${expenseCategoryMenuText(opts)}`, nextState: "expense_category", draft };
    }
    // קטגוריה מותאמת-אישית שהוכתבה בעקבות אמירת "אחר" (ר' הערה ב-expense_category למעלה) - טקסט
    // חופשי, עובר דרך אותו מנגנון Whisper כמו שאר שדות התוכן החופשי (ר' FREE_TEXT_STATES ב-routes/yemot.js).
    case "expense_category_other": {
      const customCategory = String(speech || "").trim();
      if (!customCategory) {
        return { text: `לא שמעתי קטגוריה.${retryHint()} אפשר לתאר במילים חופשיות לאיזו קטגוריה?`, nextState: "expense_category_other", draft };
      }
      return {
        text: `לאשר: הוצאה של ${draft.amount} שקלים בקטגוריית ${customCategory}? ${confirmMenuText(opts)}`,
        nextState: "expense_confirm",
        draft: { ...draft, category: customCategory },
      };
    }
    case "expense_confirm": {
      // חשוב: לא "כל מה שאינו כן = לא/ביטול" - זה היה מבטל שקט את כל התנועה אם זיהוי הדיבור פשוט
      // לא הבין את המילה (למשל "אישור" שלפעמים לא מזוהה, ר' isConfirmYes). מבטלים רק ב"לא" מפורש,
      // ובכל קלט לא ברור אחר שואלים שוב את אותה שאלה במקום למחוק את מה שהמשתמש כבר הזין.
      if (isConfirmYes(s, opts)) {
        db.prepare("INSERT INTO transactions (user_id, type, amount, category, source) VALUES (?, 'expense', ?, ?, 'phone')")
          .run(user.id, draft.amount, draft.category);
        // "מילון" הקטגוריות האישי - אותו kind בדיוק כמו הוספת תנועה דרך האתר (ר' routes/transactions.js)
        // כדי שקטגוריה שהוכתבה בטלפון (למשל "תרופות") תוצע גם באתר בפעם הבאה, ולהפך.
        if (draft.category) rememberPhrase(user.id, "expense_category", draft.category);
        return askMoreOrFinish(`נשמר. הוצאה של ${draft.amount} שקלים ב${draft.category}.`, "expense_saved");
      }
      // "שינוי" (2, ר' wantsMenuChange) - חוזרים להתחלת הפריט (סכום) כדי להזין הכל מחדש, במקום
      // ביטול מוחלט - משוב אמיתי ממשתמש שרצה דרך לתקן טעות בלי לחזור לתפריט הראשי ולהתחיל מאפס.
      if (wantsMenuChange(s, opts)) return { text: "בסדר, נתחיל מחדש. כמה עלה, בשקלים?", nextState: "expense_amount" };
      if (isConfirmNo(s, opts) || wantsMenuCancel(s, opts)) {
        return { text: `בוטל. אפשר להתחיל שוב, מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      }
      return {
        text: `לא הבנתי.${retryHint()} לאשר: הוצאה של ${draft.amount} שקלים בקטגוריית ${draft.category}? ${confirmMenuText(opts)}`,
        nextState: "expense_confirm",
        draft,
      };
    }

    // ---------- הכנסה ----------
    case "income_amount": {
      const amount = extractAmount(s);
      if (!amount) return { text: `לא זיהיתי סכום.${retryHint()} מה סכום ההכנסה?`, nextState: "income_amount" };
      return { text: `לאשר: הכנסה של ${amount} שקלים? ${confirmMenuText(opts)}`, nextState: "income_confirm", draft: { amount } };
    }
    case "income_confirm": {
      // ר' הערה ב-expense_confirm - אותו עיקרון: מבטלים רק ב"לא" מפורש, לא בכל קלט לא ברור.
      if (isConfirmYes(s, opts)) {
        db.prepare("INSERT INTO transactions (user_id, type, amount, source) VALUES (?, 'income', ?, 'phone')").run(user.id, draft.amount);
        return askMoreOrFinish(`נשמר. הכנסה של ${draft.amount} שקלים.`, "income_saved");
      }
      if (wantsMenuChange(s, opts)) return { text: "בסדר, נתחיל מחדש. מה סכום ההכנסה?", nextState: "income_amount" };
      if (isConfirmNo(s, opts) || wantsMenuCancel(s, opts)) {
        return { text: `בוטל. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      }
      return {
        text: `לא הבנתי.${retryHint()} לאשר: הכנסה של ${draft.amount} שקלים? ${confirmMenuText(opts)}`,
        nextState: "income_confirm",
        draft,
      };
    }

    // ---------- חונכות ----------
    // תפריט-הקשה של עד 9 התלמידים הרשומים (ר' startMentorFlow למעלה) - מצב הקשה טהור-ברובו: הקשת
    // מספר בוחרת תלמיד ישר, בלי לעבור כלל דרך זיהוי דיבור. הקשה/אמירה "0"/"אחר" היא שסתום לתלמיד
    // שלא ברשימה - עובר לשלב ההכתבה החופשית הרגילה (mentor_pick_student). אם בכל זאת הגיע קלט מדובר
    // (בעיקר בטוויליו, שאין בו הקשות אמינות) - עדיין מנסים להתאים אותו לשם תלמיד קיים כגיבוי, לפני
    // שמוותרים לגמרי ושואלים שוב.
    case "mentor_pick_student_list": {
      const options = draft.studentListOptions || [];
      const digit = singleDigitPress(s);
      if (digit === "0" || includesAny(s, ["אחר", "שם אחר", "לא ברשימה", "תלמיד אחר"])) {
        return { text: "מה שם התלמיד?", nextState: "mentor_pick_student" };
      }
      const idx = digit ? Number(digit) - 1 : -1;
      if (idx >= 0 && idx < options.length) {
        return {
          text: mentorActionPrompt(options[idx].name, opts),
          nextState: "mentor_action",
          draft: { studentId: options[idx].id, studentName: options[idx].name },
        };
      }
      if (!looksLikeRawDigitsArtifact(s)) {
        const student = findStudentByName(user.id, s);
        if (student) {
          return {
            text: mentorActionPrompt(student.name, opts),
            nextState: "mentor_action",
            draft: { studentId: student.id, studentName: student.name },
          };
        }
      }
      return {
        text: `לא הבנתי.${retryHint()} ${mentorStudentListText(options)}`,
        nextState: "mentor_pick_student_list",
        draft,
      };
    }
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
      // digit: ר' singleDigitPress - סולח על "Digits-11"/"Digits-111" וכו' (הקשה כפולה/ממושכת של אותה
      // ספרה שימות לפעמים מדווחת עליה במחרוזת חוזרת) - זה בדיוק מה שגרם בעבר ליצירת תלמיד עם השם
      // המילולי "Digits-11" (ר' באג אמיתי שנמצא בבדיקה חיה): onlyDigits("Digits-11")==="11", לא תואם
      // ל-"1"/"2" בהשוואה מדויקת, אז זה "נפל" בטעות למסלול "מנסים שוב כאילו זה שם תלמיד" למטה.
      const digit = singleDigitPress(s);
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
      // תוקן (אותו באג אמיתי שהוזכר למעלה - ר' singleDigitPress): שארית הקשה גולמית לא-מזוהה (למשל
      // הקשה בת 2 ספרות שונות, לא נתמכת) **לא** אמורה להיחשב "ניסיון לומר שם" ולהיווצר כתלמיד בפועל -
      // רק תוכן שבאמת יכול להיות שם (לא תבנית "Digits..." של ימות עצמה) ממשיך למסלול הזה.
      if (looksLikeRawDigitsArtifact(s)) {
        return {
          text: `לא הבנתי.${retryHint()} רוצים להוסיף את ${draft.pendingStudentName} כתלמיד חדש?${addStudentDigitsNote(opts)}`,
          nextState: "mentor_confirm_add_student",
          draft,
        };
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
      const digit = singleDigitPress(s);
      if (digit === "2" || includesAny(s, ["אאוט", "יציאה", "סיום"])) return doCheckout(draft, user);
      if (digit === "1" || includesAny(s, ["אין", "כניסה", "התחלה"])) return doCheckin(draft);
      // "מפגש" נכלל כאן בנוסף ל"רגיל"/"מהיר"/"קבוע" - בבדיקה בפועל זיהוי הדיבור לפעמים קלט רק את המילה
      // הראשונה מתוך "מפגש רגיל" (שתי מילים) והשמיט את השנייה, אז בלי "מפגש" עצמו ברשימה זה לא היה מזוהה בכלל.
      if (digit === "3" || includesAny(s, ["רגיל", "מהיר", "קבוע", "מפגש"])) return doQuickSession(draft, user);
      if (digit === "4" || includesAny(s, ["הסר", "הסרה", "להסיר", "מחיקה", "מחק", "לא לומד", "הפסיק"])) {
        return {
          text: `לאשר: להסיר את ${draft.studentName} מרשימת התלמידים שלך? התלמיד לא יימחק לצמיתות, רק לא יופיע יותר ברשימה הפעילה - כל ההיסטוריה שלו נשארת בתיק. ${confirmMenuText(opts)}`,
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
      // "שינוי" כאן = אולי התכוונתם לתלמיד אחר - חוזרים לבחירת תלמיד מחדש, לא רק מבטלים לגמרי.
      if (wantsMenuChange(s, opts)) return { text: "בסדר, מה שם התלמיד?", nextState: "mentor_pick_student" };
      if (isConfirmNo(s, opts) || wantsMenuCancel(s, opts)) {
        return { text: `בסדר, לא הסרנו. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      }
      return {
        text: `לא הבנתי.${retryHint()} לאשר: להסיר את ${draft.studentName} מרשימת התלמידים שלך? התלמיד לא יימחק לצמיתות, רק לא יופיע יותר ברשימה הפעילה - כל ההיסטוריה שלו נשארת בתיק. ${confirmMenuText(opts)}`,
        nextState: "mentor_remove_confirm",
        draft,
      };
    }

    // ---------- חונכות: טופס "הכנה לשיעור" בקצרה, אופציונלי, אחרי מפגש רגיל (ר' offerLessonPrep) ----------
    // משוב אמיתי ממשתמש: רק 3 השדות הראשונים מהטופס המלא באתר (LESSON_FIELDS_BASIC ב-public/app.html,
    // עד לחלק שנקרא שם "פרטים נוספים") - לא כל 14 השדות. לכל שדה: מנסים קודם הכתבה חופשית (Whisper,
    // ר' FREE_TEXT_STATES ב-routes/yemot.js) - ורק אם לא נשמע כלום, מציעים כחלופה לבחור מתוך "המילון"
    // האישי (ר' getDictionary) בהקשה בלבד (lessonPickState) - במקום להמשיך לנסות בקול שוב ושוב.
    // "שינוי"/"ביטול" בסוף (lesson_prep_confirm, ר' CONFIRM_MENU_STATES) מתנהגים כמו כל שאר צמתי
    // האישור המשולשים: 2 מתחיל את כל 3 השדות מחדש, 3 מבטל את הטופס (בלי לוותר על המפגש עצמו).
    case "lesson_prep_offer": {
      if (isConfirmYes(s, opts)) {
        return { text: LESSON_PREP_FIELDS[0].question, nextState: lessonSpeakState(0), draft: { ...draft, lessonPrep: {} } };
      }
      if (isConfirmNo(s, opts)) return offerMentorNote(draft.mentorUserId, draft.sessionId, draft.baseMessage, draft.outcome);
      return {
        text: `לא הבנתי.${retryHint()} רוצים גם למלא טופס הכנה לשיעור בקצרה - קטע נלמד, מטרה, יישום בפועל, ושיתוף פעולה? זה לא חובה. אמרו כן, או הקישו 1. אם לא, אמרו לא, או הקישו 2.`,
        nextState: "lesson_prep_offer",
        draft,
      };
    }
    case "lesson_prep_topic_studied_speak": case "lesson_prep_goal_speak":
    case "lesson_prep_practical_application_speak": case "lesson_prep_connection_cooperation_speak": {
      return handleLessonFieldSpeak(lessonFieldIndexFromState(state), speech, draft, opts);
    }
    case "lesson_prep_topic_studied_retry": case "lesson_prep_goal_retry":
    case "lesson_prep_practical_application_retry": case "lesson_prep_connection_cooperation_retry": {
      return handleLessonFieldRetry(lessonFieldIndexFromState(state), s, draft);
    }
    case "lesson_prep_topic_studied_pick": case "lesson_prep_goal_pick":
    case "lesson_prep_practical_application_pick": case "lesson_prep_connection_cooperation_pick": {
      return handleLessonFieldPick(lessonFieldIndexFromState(state), s, draft, opts);
    }
    case "lesson_prep_confirm": {
      if (isConfirmYes(s, opts)) {
        const lp = draft.lessonPrep || {};
        db.prepare(
          "INSERT INTO lesson_reports (student_id, mentor_user_id, topic_studied, goal, practical_application, connection_cooperation) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(draft.studentId, draft.mentorUserId, lp.topic_studied || null, lp.goal || null, lp.practical_application || null, lp.connection_cooperation || null);
        for (const f of LESSON_PREP_FIELDS) {
          if (lp[f.id]) rememberPhrase(draft.mentorUserId, f.dictKind, lp[f.id]);
        }
        return offerMentorNote(draft.mentorUserId, draft.sessionId, `${draft.baseMessage} טופס ההכנה לשיעור נשמר.`, draft.outcome);
      }
      if (wantsMenuChange(s, opts)) {
        return { text: LESSON_PREP_FIELDS[0].question, nextState: lessonSpeakState(0), draft: { ...draft, lessonPrep: {} } };
      }
      if (isConfirmNo(s, opts) || wantsMenuCancel(s, opts)) {
        return offerMentorNote(draft.mentorUserId, draft.sessionId, draft.baseMessage, draft.outcome);
      }
      return { text: `לא הבנתי.${retryHint()} ${lessonPrepConfirmText(draft, opts)}`, nextState: "lesson_prep_confirm", draft };
    }

    // ---------- חונכות: דיווח מעקב חופשי אופציונלי אחרי checkout/quick-session (ר' offerMentorNote) ----------
    // mentor_note_offer הוא כן/לא רגיל (לא Whisper) - קיצור הקשה 1/2 אמין תמיד עובד גם אם זיהוי
    // הדיבור לא יתפוס "כן"/"לא". mentor_note_speak (ההכתבה עצמה) כן עובר דרך Whisper (ר' FREE_TEXT_STATES
    // ב-routes/yemot.js) - זה בדיוק כמו therapist_note/supervisor_readback, רק אופציונלי ומתחבר
    // למפגש חונכות שכבר נשמר (sessions.note) במקום ליצור רשומה חדשה.
    case "mentor_note_offer": {
      if (isConfirmYes(s, opts)) {
        return {
          text: "אפשר לתאר במילים חופשיות מה עשיתם במפגש, ואיך התלמיד התקדם.",
          nextState: "mentor_note_speak",
          draft,
        };
      }
      if (isConfirmNo(s, opts)) return askMoreOrFinish(draft.baseMessage, draft.outcome);
      return {
        text: `לא הבנתי.${retryHint()} רוצים להוסיף גם דיווח מעקב חופשי על המפגש? זה לא חובה. אמרו כן, או הקישו 1. אם לא, אמרו לא, או הקישו 2.`,
        nextState: "mentor_note_offer",
        draft,
      };
    }
    case "mentor_note_speak": {
      const noteTrim = String(speech || "").trim();
      // בדיוק כמו signup_email_speak - "דלג" (או שתיקה) תמיד משלים בלי דיווח, בלי תלות בזיהוי דיבור נוסף.
      if (!noteTrim || includesAny(s, ["דלג", "לדלג", "לא רוצה", "בלי", "ביטול", "וויתור", "לוותר", "אין לי", "לא צריך", "עזוב"])) {
        return askMoreOrFinish(draft.baseMessage, draft.outcome);
      }
      return {
        text: `לאשר: הדיווח הוא "${noteTrim}"? ${confirmMenuText(opts)}`,
        nextState: "mentor_note_confirm",
        draft: { ...draft, pendingNote: noteTrim },
      };
    }
    case "mentor_note_confirm": {
      if (isConfirmYes(s, opts)) {
        db.prepare("UPDATE sessions SET note = ? WHERE id = ?").run(draft.pendingNote, draft.sessionId);
        // אותו "מילון" ניסוחים אישי שכבר קיים באתר (kind=session_note, ר' routes/students.js) - כדי
        // שניסוחים נפוצים יוצעו אוטומטית גם שם בפעם הבאה, גם אם הדיווח הוכתב בטלפון ולא הוקלד באתר.
        rememberPhrase(draft.mentorUserId, "session_note", draft.pendingNote);
        return askMoreOrFinish(`${draft.baseMessage} הדיווח נשמר.`, draft.outcome);
      }
      // "שינוי" (2) - זה בדיוק מה ש"לא" עשתה כאן בעבר (נסיון הכתבה חוזר) - עכשיו יש גם "ביטול" (3)
      // אמיתי בנוסף, כדי לוותר על הדיווח לגמרי בלי להיכנס ללולאת הכתבה-מחדש אינסופית.
      if (wantsMenuChange(s, opts)) {
        return { text: "בסדר, ננסה שוב. אפשר לתאר שוב במילים חופשיות מה עשיתם במפגש?", nextState: "mentor_note_speak", draft: { ...draft, pendingNote: undefined } };
      }
      if (isConfirmNo(s, opts) || wantsMenuCancel(s, opts)) {
        return askMoreOrFinish(draft.baseMessage, draft.outcome);
      }
      return {
        text: `לא הבנתי.${retryHint()} לאשר: הדיווח הוא "${draft.pendingNote}"? ${confirmMenuText(opts)}`,
        nextState: "mentor_note_confirm",
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
        text: `לאשר דיווח על ${draft.studentName}: ${speech}. ${confirmMenuText(opts)}`,
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
      if (wantsMenuChange(s, opts)) return { text: "בסדר, אפשר לתאר שוב את תוכן הדיווח?", nextState: "therapist_note", draft };
      if (isConfirmNo(s, opts) || wantsMenuCancel(s, opts)) {
        return { text: `בוטל. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      }
      return {
        text: `לא הבנתי.${retryHint()} לאשר דיווח על ${draft.studentName}: ${draft.note}. ${confirmMenuText(opts)}`,
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
        text: `לאשר הערה על ${draft.studentName}: ${speech}. ${confirmMenuText(opts)}`,
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
      if (wantsMenuChange(s, opts)) return { text: "בסדר, אפשר לתאר שוב את תוכן ההערה?", nextState: "supervisor_readback", draft };
      if (isConfirmNo(s, opts) || wantsMenuCancel(s, opts)) {
        return { text: `בוטל. מה תרצו לעשות? ${mainMenuCategoriesText()}`, nextState: "main_menu", hints: MAIN_MENU_HINTS };
      }
      return {
        text: `לא הבנתי.${retryHint()} לאשר הערה על ${draft.studentName}: ${draft.text}. ${confirmMenuText(opts)}`,
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
    // תוקן (משוב אמיתי ממשתמש): בעבר, אחרי הכתבת השם (שכבר מוקלטת ומתומללת ב-Whisper, ר' README) עוד
    // ביקשנו אישור נפרד ("לאשר: נרשמים בשם X... אמרו כן") לפני שממשיכים לקוד PIN - צעד כפול ומיותר,
    // שהמשתמש ציין שהוא רוצה לדלג עליו. עכשיו ממשיכים **ישר** מהשם לקוד PIN, בלי שאלת אישור נפרדת -
    // עדיין "חוזרים" על השם בתחילת המשפט הבא ("שלום X, עכשיו...") כדי שיהיה ברור מיד מה נקלט, בדיוק
    // כמו mentorActionPrompt/therapist_student וכו', רק בלי לדרוש אמירת "כן" בנפרד. אם השם נקלט לא
    // נכון - עדיין אפשר לתקן אותו אחר כך באתר (בדיוק כמו שאר הפרטים בהרשמה טלפונית).
    case "signup_name": {
      const fullName = String(speech || "").trim();
      if (!fullName) return { text: `לא שמעתי שם.${retryHint()} מה השם המלא שלכם?`, nextState: "signup_name" };
      return {
        text: `שלום ${fullName}. עכשיו נגדיר קוד סודי בן 4 ספרות - הוא ישמש גם לכניסה לאתר בעתיד. הקישו עכשיו 4 ספרות במקלדת הטלפון.`,
        nextState: "signup_pin",
        draft: { ...draft, fullName },
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
          text: "הקוד הוגדר בהצלחה. רוצים לצרף כתובת מייל קיימת לחשבון? זה לא חובה, ואפשר גם להוסיף אותה מאוחר יותר באתר - זה לרוב קל יותר אם יש בכתובת גם אותיות באנגלית. אמרו כן, או הקישו 1. אם לא, אמרו לא, או הקישו 2.",
          nextState: "signup_email_offer",
          draft: { ...draft, pin: draft.pendingPin, pendingPin: undefined },
        };
      }
      return {
        text: "הספרות לא תאמו. ננסה שוב מההתחלה - הקישו 4 ספרות חדשות לקוד הסודי.",
        nextState: "signup_pin",
        draft: { ...draft, pendingPin: undefined },
      };
    }
    // תוקן (משוב אמיתי ממשתמש בבדיקה חיה): בעבר בשלב הזה לא ביקשנו לדבר בכלל - רק בחירת ספק בהקשה
    // (1/2/0), וה"כתובת" עצמה נבנתה אוטומטית מתעתיק לטיני של השם המלא (ר' buildEmailLocalPart/
    // HEBREW_TO_LATIN שהוסרו). זו לא הייתה כתובת אמיתית שאפשר לשלוח אליה שום דבר - בדיוק מה שגרם
    // לבלבול ("לחצתי 1 וזה לא נכון"). התיקון: קודם שואלים כן/לא רגיל אם יש כתובת קיימת לצרף (שלב
    // "רגיל" - לא טקסט חופשי, בדיוק כמו expense_confirm וכו') - ורק אם "כן", עוברים לבקש להכתיב את
    // הכתובת האמיתית בקול (case "signup_email_speak", כן טקסט חופשי - ר' FREE_TEXT_STATES ב-
    // routes/yemot.js). בניסיון קודם (מתועד למטה, ר' parseSpokenEmail) הכתבת מייל בקול נכשלה כמעט
    // תמיד מול מנוע הזיהוי המובנה של ימות - אבל עכשיו, עם אותו מנגנון תמלול Whisper מדויק שכבר
    // עובד היטב בתפריט הראשי, יש סיכוי טוב בהרבה שזה יעבוד. אם בכל זאת לא מצליחים לפענח כתובת
    // תקינה - פשוט מדלגים (בלי מייל, אפשר להוסיף אח"כ באתר) במקום להמציא כתובת מזויפת.
    case "signup_email_offer": {
      if (isConfirmYes(s, opts)) {
        return {
          text: "אמרו את כתובת המייל שלכם עכשיו, לאט אם אפשר. לדוגמה: שם המשתמש, שטרודל, ג'ימייל. אם התחרטתם - פשוט אל תגידו כלום וחכו בשקט.",
          nextState: "signup_email_speak",
          draft,
        };
      }
      if (isConfirmNo(s, opts)) {
        const newUser = createPhoneUser(draft.fullName, draft.phone, null, draft.pin);
        return {
          text: `נרשמת בהצלחה! ${mainMenuPrompt(newUser.full_name, opts)}`,
          nextState: "main_menu",
          newUserId: newUser.id,
          hints: MAIN_MENU_HINTS,
          outcome: "phone_signup_completed",
        };
      }
      return {
        text: `לא הבנתי.${retryHint()} רוצים לצרף כתובת מייל קיימת לחשבון? זה לא חובה. אמרו כן, או הקישו 1. אם לא, אמרו לא, או הקישו 2.`,
        nextState: "signup_email_offer",
        draft,
      };
    }
    // תוקן (משוב אמיתי ממשתמש בבדיקה חיה - מקרה חמור): אמירת "דלג" בשלב הזה לא תמיד נקלטת נכון
    // ע"י Whisper (יתכן שה"רמז אוצר מילים" המוטה לכיוון מילות כתובת מייל - ר' vocabularyHintFor
    // ב-routes/yemot.js - "מושך" את התמלול לכיוון לא נכון גם כשבפועל נאמרה רק מילת דילוג קצרה) -
    // וזה השאיר משתמש **תקוע בלולאה בלי שום דרך החוצה** עד שניתק את השיחה, למרות שהמייל לא חובה בכלל!
    // זה באג חמור בהרבה מסתם "לא נוח" - חובה שתמיד תהיה דרך החוצה אמינה. התיקון: אחרי ניסיון הכתבה
    // כושל (לא זוהתה כתובת תקינה ולא זוהתה מילת דילוג), **לא** חוזרים ישר לעוד ניסיון הקלטה (שוב
    // תלוי בזיהוי דיבור) - עוברים לשלב ביניים "רגיל" (לא טקסט חופשי, לא תלוי בהקלטה בכלל) שבו הקשת
    // ספרה **תמיד** עובדת: 1=לנסות שוב, 0=לדלג ולסיים את ההרשמה מיד, בלי שום תלות בזיהוי דיבור נוסף.
    case "signup_email_retry": {
      const digit = singleDigitPress(s);
      if (digit === "1" || includesAny(s, ["כן", "שוב", "נסה שוב", "לנסות שוב"])) {
        return { text: "בסדר, אמרו את כתובת המייל שלכם עכשיו, לאט אם אפשר.", nextState: "signup_email_speak", draft };
      }
      if (digit === "0" || isConfirmNo(s, opts) || includesAny(s, ["דלג", "לדלג"])) {
        const newUser = createPhoneUser(draft.fullName, draft.phone, null, draft.pin);
        return {
          text: `נרשמת בהצלחה! ${mainMenuPrompt(newUser.full_name, opts)}`,
          nextState: "main_menu",
          newUserId: newUser.id,
          hints: MAIN_MENU_HINTS,
          outcome: "phone_signup_completed",
        };
      }
      return {
        text: `לא הבנתי.${retryHint()} לנסות שוב להכתיב את כתובת המייל - הקישו 1. לדלג ולהמשיך בלי מייל - הקישו 0.`,
        nextState: "signup_email_retry",
        draft,
      };
    }
    case "signup_email_speak": {
      const spokenTrim = String(speech || "").trim();
      // אם אין כלום, או שנאמרה בפירוש מילת דילוג/ויתור - ממשיכים בלי מייל מיד (לא תוקעים בלולאה,
      // ולא מחכים לשלב הקשה - זה עדיין "בונוס" למי שאמירת הדילוג שלו כן זוהתה נכון).
      if (!spokenTrim || includesAny(s, ["דלג", "לדלג", "לא רוצה", "בלי מייל", "ללא מייל", "ביטול", "וויתור", "לוותר", "אין לי", "לא צריך", "עזוב", "בלי"])) {
        const newUser = createPhoneUser(draft.fullName, draft.phone, null, draft.pin);
        return {
          text: `נרשמת בהצלחה! ${mainMenuPrompt(newUser.full_name, opts)}`,
          nextState: "main_menu",
          newUserId: newUser.id,
          hints: MAIN_MENU_HINTS,
          outcome: "phone_signup_completed",
        };
      }
      const parsed = parseSpokenEmail(speech);
      if (!parsed) {
        // ר' הערה למעלה ליד case "signup_email_retry" - **לא** חוזרים ישר לעוד ניסיון הקלטה, כדי
        // שתמיד תהיה דרך החוצה אמינה בהקשה, גם אם זיהוי הדיבור ימשיך להיכשל.
        return {
          text: `לא הצלחתי להבין כתובת מייל תקינה מתוך "${spokenTrim}". לנסות שוב להכתיב אותה - הקישו 1. לדלג ולהמשיך בלי מייל - הקישו 0.`,
          nextState: "signup_email_retry",
          draft,
        };
      }
      return {
        text: `לאשר: כתובת המייל שלכם היא ${parsed}? ${confirmMenuText(opts)}`,
        nextState: "signup_email_confirm",
        draft: { ...draft, pendingEmail: parsed },
      };
    }
    case "signup_email_confirm": {
      if (isConfirmYes(s, opts)) {
        const newUser = createPhoneUser(draft.fullName, draft.phone, draft.pendingEmail, draft.pin);
        return {
          text: `נרשמת בהצלחה! נשמרה גם כתובת המייל ${draft.pendingEmail} (אפשר לשנות אותה מאוחר יותר באתר). ${mainMenuPrompt(newUser.full_name, opts)}`,
          nextState: "main_menu",
          newUserId: newUser.id,
          hints: MAIN_MENU_HINTS,
          outcome: "phone_signup_completed",
        };
      }
      // "שינוי" (2) - זה בדיוק מה ש"לא" עשתה כאן בעבר (הכתבה חוזרת) - "ביטול" (3) חדש: מדלגים על
      // המייל לגמרי ומסיימים את ההרשמה בלעדיו (בדיוק כמו דילוג ב-signup_email_retry/signup_email_speak).
      if (wantsMenuChange(s, opts)) {
        return {
          text: "בסדר, ננסה שוב. אמרו את כתובת המייל שלכם עכשיו, לאט אם אפשר.",
          nextState: "signup_email_speak",
          draft: { ...draft, pendingEmail: undefined },
        };
      }
      if (isConfirmNo(s, opts) || wantsMenuCancel(s, opts)) {
        const newUser = createPhoneUser(draft.fullName, draft.phone, null, draft.pin);
        return {
          text: `נרשמת בהצלחה! ${mainMenuPrompt(newUser.full_name, opts)}`,
          nextState: "main_menu",
          newUserId: newUser.id,
          hints: MAIN_MENU_HINTS,
          outcome: "phone_signup_completed",
        };
      }
      return {
        text: `לא הבנתי.${retryHint()} לאשר: כתובת המייל שלכם היא ${draft.pendingEmail}? ${confirmMenuText(opts)}`,
        nextState: "signup_email_confirm",
        draft,
      };
    }
    default:
      return { text: "מה השם המלא שלכם?", nextState: "signup_name", draft };
  }
}

// ---------- כתובת מייל בהרשמה טלפונית: פענוח הכתבה בקול ----------
// מזהה מילות סימנים נפוצות בעברית ("שטרודל"/"כרוכית" ל-@, "נקודה" לנקודה וכו') וגם ספקי מייל
// נפוצים - ומחזיר כתובת מייל תקינה אם אפשר לזהות אחת בבירור, אחרת null (ואז מבקשים לנסות שוב,
// ר' case "signup_email_speak"). לא מנסה לפרש ספרות שנאמרו במילים (למשל "שמונים וחמש") - Whisper
// בדרך כלל כבר מתמלל מספרים קצרים כספרות; אם לא, המשתמש יתפוס את זה בקריאה חוזרת לאישור
// (ר' signup_email_confirm) וינסה שוב.
// תוקן (נבדק ידנית מול כמה ניסוחים אמיתיים אפשריים): גרסה קודמת "מחקה" מילת ספק כמו "ג'ימייל" מהטקסט
// כדי להשלים סיומת ".com" אוטומטית - אבל זה שבר בדיוק את המקרה הכי טבעי, שבו המתקשר כן אומר את כל
// הכתובת במפורש כולל שם הספק ("...שטרודל ג'ימייל נקודה קום") - המילה "gmail" עצמה נמחקה בטעות ונשארה
// כתובת שבורה כמו "...@.com". התיקון: **מחליפים** מילת ספק בשם הלטיני שלה (לא מוחקים), כך שהיא
// נשארת חלק אמיתי מהכתובת בכל מקרה; והשלמת סיומת דומיין קורית רק בסוף, אם אחרי כל ההחלפות עדיין
// אין נקודה בחלק הדומיין (כלומר המתקשר אמר רק "ג'ימייל" בלי "נקודה קום" בכלל).
const PROVIDER_WORD_TO_ASCII = [
  { words: ["ג'ימייל", "גימייל", "גימיל", "gmail"], ascii: "gmail" },
  { words: ["אאוטלוק", "אוטלוק", "outlook"], ascii: "outlook" },
  { words: ["הוטמייל", "hotmail"], ascii: "hotmail" },
  { words: ["וואלה", "walla"], ascii: "walla" },
  { words: ["יאהו", "yahoo"], ascii: "yahoo" },
];
// סיומת דומיין ידועה לכל ספק - משמשת רק כשלא נאמרה סיומת מפורשת בכלל (ר' PROVIDER_WORD_TO_ASCII).
const PROVIDER_TLD = { gmail: "gmail.com", outlook: "outlook.com", hotmail: "hotmail.com", walla: "walla.co.il", yahoo: "yahoo.com" };
const EMAIL_REGEX = /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

// טבלת תעתיק גס (עיצורים בעיקר) מעברית ללטינית - לא לבניית כתובת מזויפת (ר' ההערה למעלה על מה
// שהוסר), אלא כדי **לתעתק את מה שהמתקשר בפועל אמר**: Whisper מתמלל דיבור עברי באותיות עבריות
// תמיד, גם אם המתקשר בעצם התכוון לשם משתמש/כתובת שהם באנגלית (למשל "שלום 85" ולא "shalom85") -
// בלי תעתיק, החלק שנאמר בעברית היה נמחק לגמרי (ר' הסינון ל-a-z0-9 בהמשך) והכתובת הייתה תמיד ריקה.
// לא מדויק בלשנית - אבל זה בסדר: התוצאה תמיד מוקראת בחזרה לאישור, כך שהמתקשר יתפוס ניחוש שגוי.
const HEBREW_TO_LATIN = {
  א: "a", ב: "b", ג: "g", ד: "d", ה: "h", ו: "v", ז: "z", ח: "ch", ט: "t",
  י: "i", כ: "k", ך: "k", ל: "l", מ: "m", ם: "m", נ: "n", ן: "n", ס: "s",
  ע: "a", פ: "p", ף: "f", צ: "tz", ץ: "tz", ק: "k", ר: "r", ש: "sh", ת: "t",
};

function parseSpokenEmail(rawSpeech) {
  let t = String(rawSpeech || "").trim().toLowerCase();
  if (!t) return null;

  // מחליפים מילת ספק (בעברית או באנגלית) בשם הלטיני התקני שלה - **החלפה**, לא מחיקה (ר' הערה למעלה).
  for (const p of PROVIDER_WORD_TO_ASCII) {
    for (const w of p.words) {
      if (t.includes(w)) t = t.split(w).join(p.ascii);
    }
  }

  t = t
    // "נקודה קום/נט/אורג" כרצף אחד -> סיומת דומיין ישירה (לפני ההחלפה הכללית של "נקודה" בלבד ל-".")
    // - כדי לתמוך בניסוח הכי טבעי ("...ג'ימייל נקודה קום") בלי תלות בהשלמה האוטומטית שבסוף הפונקציה.
    .replace(/נקודה\s*קום/g, ".com")
    .replace(/נקודה\s*נט/g, ".net")
    .replace(/נקודה\s*אורג/g, ".org")
    .replace(/שטרודל|כרוכית/g, "@")
    .replace(/\bat\b/g, "@")
    .replace(/נקודה/g, ".")
    .replace(/\bdot\b/g, ".")
    .replace(/מקף/g, "-")
    .replace(/קו תחתון|אנדרסקור/g, "_")
    .replace(/\s+/g, "")
    .split("")
    .map(ch => HEBREW_TO_LATIN[ch] ?? ch) // מתעתק כל אות עברית שנשארה (ר' הערה למעלה)
    .join("")
    .replace(/[^a-z0-9@._-]/g, ""); // מסיר את מה שנשאר ולא ניתן לתעתק/סימן לא רלוונטי

  if (!t.includes("@")) return null;

  const atIdx = t.indexOf("@");
  const local = t.slice(0, atIdx);
  let domainPart = t.slice(atIdx + 1).replace(/@/g, ""); // רק ה-@ הראשון נחשב

  if (!local || !domainPart) return null;
  if (!domainPart.includes(".")) {
    // נאמר רק שם ספק בלי סיומת מפורשת (למשל "@gmail" בלי "נקודה קום") - משלימים אוטומטית.
    if (!PROVIDER_TLD[domainPart]) return null;
    domainPart = PROVIDER_TLD[domainPart];
  }
  const candidate = `${local}@${domainPart}`;
  return EMAIL_REGEX.test(candidate) ? candidate : null;
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

// תוקן (משוב אמיתי ממשתמש): לא חוזרים ישר לתפריט הראשי הכללי אחרי קריאת היתרה - שואלים במפורש
// אם להוסיף הכנסה/הוצאה (עם קיצור הקשה ייעודי 1/2, ר' case "balance_next_action"), בדיוק כמו שיש
// באתר. עדיין אפשר לומר כל קטגוריה אחרת או לסיים מכאן - ר' matchMainMenuCategory.
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
  return {
    text: `היתרה הנוכחית שלך היא ${balance} שקלים. רוצים להוסיף הכנסה או הוצאה, או לסיים? אפשר גם להקיש: 1 להכנסה, 2 להוצאה.`,
    nextState: "balance_next_action",
    hints: MAIN_MENU_HINTS,
    outcome: "balance_read",
  };
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
  const info = db
    .prepare("INSERT INTO sessions (student_id, mentor_user_id, method, duration_minutes) VALUES (?, ?, 'checkin_checkout', ?)")
    .run(student.id, user.id, durationMinutes);
  db.prepare("UPDATE students SET checkin_at = NULL WHERE id = ?").run(student.id);
  // אחרי שמירת המפגש, מציעים גם דיווח מעקב חופשי (כמו ה-note האופציונלי שכבר קיים באתר, ר'
  // routes/students.js checkout/quick-session) - ר' offerMentorNote למטה.
  return offerMentorNote(user.id, info.lastInsertRowid, `נרשמה יציאה עבור ${student.name}. משך המפגש: ${durationMinutes} דקות.`, "checkout_saved");
}

function doQuickSession(draft, user) {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(draft.studentId);
  const u = db.prepare("SELECT default_session_minutes FROM users WHERE id = ?").get(user.id);
  const minutes = u.default_session_minutes || 45;
  const info = db
    .prepare("INSERT INTO sessions (student_id, mentor_user_id, method, duration_minutes) VALUES (?, ?, 'quick_preset', ?)")
    .run(student.id, user.id, minutes);
  // תוקן (בקשת פיצ'ר: "אחרי שאומר מפגש") - רק אחרי מפגש רגיל (לא checkin/checkout) מציעים גם למלא
  // טופס "הכנה לשיעור" בקצרה (ר' offerLessonPrep למטה), לפני ההצעה הרגילה של דיווח מעקב חופשי.
  return offerLessonPrep(user.id, draft.studentId, info.lastInsertRowid, `נרשם מפגש עבור ${student.name}, ${minutes} דקות.`, "quick_session_saved");
}

// מציע למלא בקצרה טופס "הכנה לשיעור" (ר' LESSON_PREP_FIELDS למעלה) - רק אחרי מפגש רגיל (doQuickSession),
// לא אחרי checkin/checkout. כן/לא רגיל עם קיצור הקשה 1/2 אמין (לא Whisper) - כמו mentor_note_offer.
// בסיום (בכל מסלול - נשמר/שונה/בוטל/דולג) ממשיכים תמיד להצעת דיווח המעקב הרגילה (offerMentorNote),
// כדי לא לשנות את הזרימה הקיימת אחרי checkout.
function offerLessonPrep(mentorUserId, studentId, sessionId, baseMessage, outcome) {
  return {
    text: `${baseMessage} רוצים גם למלא טופס הכנה לשיעור בקצרה - קטע נלמד, מטרה, יישום בפועל, ושיתוף פעולה? זה לא חובה. אמרו כן, או הקישו 1. אם לא, אמרו לא, או הקישו 2.`,
    nextState: "lesson_prep_offer",
    draft: { mentorUserId, studentId, sessionId, baseMessage, outcome },
  };
}

// מציע לחונך לצרף דיווח מעקב חופשי (note) למפגש שכרגע נשמר - אותו שדה note בדיוק שכבר קיים באתר
// (sessions.note, ר' routes/students.js). רק אחרי checkout/quick-session (שם כבר יש שורת sessions
// לעדכן) - לא אחרי checkin עצמו, כי השורה ב-sessions נוצרת רק בסיום המפגש (checkout), לא בתחילתו.
// שלב זה (mentor_note_offer) הוא כן/לא רגיל עם קיצור הקשה 1/2 אמין - לא Whisper - כדי שתמיד יהיה
// אפשר לדלג בביטחון גם אם זיהוי הדיבור לא יעבוד.
function offerMentorNote(mentorUserId, sessionId, baseMessage, outcome) {
  return {
    text: `${baseMessage} רוצים להוסיף גם דיווח מעקב חופשי על המפגש - למשל מה עשיתם ואיך התלמיד התקדם? זה לא חובה, ואפשר גם להוסיף אותו מאוחר יותר באתר. אמרו כן, או הקישו 1. אם לא, אמרו לא, או הקישו 2.`,
    nextState: "mentor_note_offer",
    draft: { mentorUserId, sessionId, baseMessage, outcome },
  };
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

// משוב אמיתי ממשתמש ("אחרי שרשמתי כמה תלמידים... שיהיה לפי הרשימה, אם הראשון הוא X לחצו 1") - במקום
// לבקש תמיד לומר את שם התלמיד בקול (תלוי בזיהוי דיבור, אותה בעיה שכל השיחה הזו מנסה לצמצם), מציגים
// לחונך שכבר יש לו תלמידים רשומים תפריט ממוספר של עד 9 (הקשה בודדת, ר' MENTOR_STUDENT_LIST_LIMIT) -
// א-ב, כדי שהסדר יהיה צפוי משיחה לשיחה. הקשה **0** (או אמירת "אחר"/"שם אחר") היא שסתום-בטיחות
// למי שהתלמיד המבוקש לא ברשימה (לא רשום עדיין, או שיש יותר מ-9 ואינו בין הראשונים) - עובר לשלב
// ההכתבה החופשית הרגילה (mentor_pick_student, כמו קודם). אם אין בכלל תלמידים רשומים - מדלגים ישר
// לשלב ההכתבה (אין טעם בתפריט ריק).
const MENTOR_STUDENT_LIST_LIMIT = 9;
function startMentorFlow(user) {
  const students = db
    .prepare("SELECT id, name FROM students WHERE owner_user_id = ? AND active = 1 ORDER BY name LIMIT ?")
    .all(user.id, MENTOR_STUDENT_LIST_LIMIT);
  if (!students.length) return { text: "מה שם התלמיד?", nextState: "mentor_pick_student" };
  return {
    text: mentorStudentListText(students),
    nextState: "mentor_pick_student_list",
    draft: { studentListOptions: students },
  };
}
function mentorStudentListText(students) {
  const listText = students.map((st, idx) => `${idx + 1}) ${st.name}`).join(", ");
  return `על איזה תלמיד רוצים לדווח היום? ${listText}. הקישו את המספר, או הקישו 0 אם התלמיד לא ברשימה.`;
}

function findStudentByName(ownerUserId, spokenName) {
  const clean = normalize(spokenName);
  if (!clean) return null;
  const rows = ownerUserId
    ? db.prepare("SELECT * FROM students WHERE owner_user_id = ? AND active = 1").all(ownerUserId)
    : db.prepare("SELECT * FROM students WHERE active = 1").all();
  return rows.find(r => normalize(r.name).includes(clean) || clean.includes(normalize(r.name))) || null;
}

// תוקן (משוב אמיתי ממשתמש בבדיקה חיה): "הכנסה אמרתי 100 ש"ח והוא לא זיהה" - הסיבה: expense_amount/
// income_amount לא היו ב-FREE_TEXT_STATES, אז זיהוי הסכום עבר דרך מנוע הזיהוי המובנה (הלא-משודרג)
// של ימות, לא Whisper (ר' תיקון ב-routes/yemot.js). בנוסף, גם מנוע זיהוי דיבור טוב עלול "לכתוב"
// מספר שנאמר בקול כמילה ("מאה") ולא כספרות ("100") - התאמת regex לספרות בלבד הייתה מפספסת את זה
// לגמרי. התיקון כאן: אם אין ספרות בטקסט, מנסים לפרש מילות מספר בעברית (`parseHebrewNumberWords`)
// כרשת ביטחון נוספת - בנוסף למעבר ל-Whisper (הרבה יותר אמין למספרים, גם ככה).
function extractAmount(text) {
  const digitMatch = String(text || "").replace(/,/g, "").match(/\d+(\.\d+)?/);
  if (digitMatch) return Number(digitMatch[0]);
  const fromWords = parseHebrewNumberWords(text);
  return fromWords != null && fromWords > 0 ? fromWords : null;
}

// ---------- פענוח מספר שנאמר במילים בעברית (למשל "מאה עשרים וחמש" -> 125) ----------
// כיסוי מכוון לסכומי כסף "עגולים" טיפוסיים (לא כל דקדוק המספרים העברי המלא) - יחידות, עשרות,
// "עשר/עשרה" בתור טין, מאות (כולל "X מאות"), ואלפים (כולל "X אלפים"). מחזיר null אם לא זוהתה אף
// מילת מספר בטקסט, כדי שהקורא (extractAmount) ידע שזה כישלון אמיתי ולא "אפס".
const HEB_NUM_UNITS = {
  "אפס": 0, "אחד": 1, "אחת": 1, "שתיים": 2, "שניים": 2, "שני": 2, "שתי": 2,
  "שלוש": 3, "שלושה": 3, "ארבע": 4, "ארבעה": 4, "חמש": 5, "חמישה": 5,
  "שש": 6, "שישה": 6, "שבע": 7, "שבעה": 7, "שמונה": 8, "תשע": 9, "תשעה": 9,
  // צורת סמיכות (משמשת בעיקר לפני "אלפים"/"מאות", למשל "שלושת אלפים") - ר' פענוח "מאות"/"אלפים" למטה.
  "שלושת": 3, "ארבעת": 4, "חמשת": 5, "ששת": 6, "שבעת": 7, "שמונת": 8, "תשעת": 9, "עשרת": 10,
};
const HEB_NUM_TENS = {
  "עשרים": 20, "שלושים": 30, "ארבעים": 40, "חמישים": 50,
  "שישים": 60, "שבעים": 70, "שמונים": 80, "תשעים": 90,
};
function parseHebrewNumberWords(rawText) {
  const norm = normalize(rawText);
  if (!norm) return null;
  // "ו" מחוברת כקידומת למילה הבאה בעברית (למשל "עשרים וחמש") - מסירים אותה מכל טוקן שמתחיל בה,
  // כדי שההתאמה למילון תעבוד (בלי לפגוע במילים שבאמת מתחילות ב-ו, כי אלה ממילא לא במילוני המספרים).
  const tokens = norm.split(/\s+/).filter(Boolean).map(t => (t.length > 1 && t[0] === "ו" ? t.slice(1) : t));
  if (!tokens.length) return null;

  let result = 0;
  let chunk = 0;
  let matchedAny = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const nextT = tokens[i + 1];

    if (t in HEB_NUM_UNITS) {
      // בדיקת "טין" (11-19): יחידה ואחריה "עשר"/"עשרה" - למשל "חמש עשרה" = 15.
      if (nextT === "עשר" || nextT === "עשרה") {
        chunk += HEB_NUM_UNITS[t] + 10;
        i++; // דילוג על מילת ה"עשר/עשרה" שכבר נספרה
      } else {
        chunk += HEB_NUM_UNITS[t];
      }
      matchedAny = true;
      continue;
    }
    if (t === "עשר" || t === "עשרה") {
      chunk += 10;
      matchedAny = true;
      continue;
    }
    if (t in HEB_NUM_TENS) {
      chunk += HEB_NUM_TENS[t];
      matchedAny = true;
      continue;
    }
    if (t === "מאה") {
      chunk += 100;
      matchedAny = true;
      continue;
    }
    if (t === "מאתיים") {
      chunk += 200;
      matchedAny = true;
      continue;
    }
    if (t === "מאות") {
      // "שלוש מאות" - היחידה שנצברה כרגע ב-chunk (3) הופכת למאות (300).
      chunk = (chunk || 1) * 100;
      matchedAny = true;
      continue;
    }
    if (t === "אלף") {
      result += (chunk || 1) * 1000;
      chunk = 0;
      matchedAny = true;
      continue;
    }
    if (t === "אלפיים") {
      result += 2000;
      chunk = 0;
      matchedAny = true;
      continue;
    }
    if (t === "אלפים") {
      // "שלושה אלפים" - היחידה שנצברה כרגע ב-chunk (3) הופכת לאלפים (3000).
      result += (chunk || 1) * 1000;
      chunk = 0;
      matchedAny = true;
      continue;
    }
    // מילה לא מזוהה - מתעלמים (למשל "שקלים"/"שח"/"בערך") וממשיכים לטוקן הבא
  }

  if (!matchedAny) return null;
  return result + chunk;
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
    // singleDigitPress (לא onlyDigits ישירות) - סולח על הקשה כפולה/ממושכת של אותה ספרה שימות
    // לפעמים מדווחת עליה כמחרוזת חוזרת ("Digits-11" וכו', ר' באג אמיתי בהערה ליד singleDigitPress).
    return singleDigitPress(trimmed) === "1" || trimmed === "#";
  }
  return false;
}

// בודק אם תשובה נחשבת במפורש "לא" בצומת אישור - מילה מדוברת, או הקשת 2 (עקבי עם שאר התפריטים בהם
// 2 הוא תמיד "לא"/ביטול). חשוב: זה **לא** סתם "לא isConfirmYes" - ר' ההערה בכל צומת אישור למה.
// עדיין בשימוש בצמתי כן/לא "רגילים" (למשל mentor_note_offer) - לא בששת צמתי "אישור/שינוי/ביטול"
// המשולשים (ר' wantsMenuChange/wantsMenuCancel למטה) - שם 2 הוא "שינוי", לא "לא".
function isConfirmNo(s, opts) {
  if (includesAny(s, ["לא", "ביטול", "בטל"])) return true;
  if (opts && opts.digitConfirm) return singleDigitPress(String(s || "").trim()) === "2";
  return false;
}

// משוב אמיתי ממשתמש: בערוצים עם הקשה (ימות), שאלות אישור על ערך שקל "לשנות" (סכום/הערה/דיווח)
// עוברות ממודל בינארי (1=אישור, 2=ביטול) למודל משולש: 1=אישור, 2=שינוי (חוזרים לשלב הקודם כדי
// להזין מחדש), 3=ביטול (חוזרים לתפריט הראשי). זה **נפרד** מ-isConfirmYes/isConfirmNo (שנשארות ללא
// שינוי, עדיין בשימוש בצמתים בינאריים "רגילים" כמו mentor_note_offer/mentor_confirm_add_student,
// ששם אין "שינוי" הגיוני) - בשימוש רק בששת הצמתים המשולשים: expense_confirm/income_confirm/
// mentor_remove_confirm/mentor_note_confirm/therapist_confirm/supervisor_confirm.
// לא בזיהוי דיבור בכלל (ר' routes/yemot.js, CONFIRM_MENU_STATES) - הצמתים האלה עוברים למצב הקשה
// טהור (tap, בדיוק כמו קוד ה-PIN) כשמגיעים אליהם, כדי לחסוך את זמן ההמתנה לזיהוי דיבור/עיבוד קול
// שהיה גורם לשקט מיותר בין שלב לשלב (משוב אמיתי) - ולכן בדיקת המילים המדוברות ("כן"/"לא") ב-
// isConfirmYes/isConfirmNo נשארת כרשת ביטחון בלבד (רלוונטית בעיקר לערוץ Twilio, שאין בו הקשות).
function wantsMenuChange(s, opts) {
  return !!(opts && opts.digitConfirm && singleDigitPress(String(s || "").trim()) === "2");
}
function wantsMenuCancel(s, opts) {
  return !!(opts && opts.digitConfirm && singleDigitPress(String(s || "").trim()) === "3");
}

// טקסט נוסף שמצטרף לשאלות אישור בערוצים שתומכים בהקשה (ר' isConfirmYes/isConfirmNo) - מציע גם
// הקשת 1 לאישור מהיר וגם הקשת 2 לביטול מפורש, לא רק סולמית (סולמית בודדת התבררה כלא אמינה במצב
// זיהוי דיבור של ימות - ר' isConfirmYes). מוזכרות שתי הספרות יחד כדי שהמתקשר ידע משתי האפשרויות
// מראש, ולא רק שיש קיצור-אישור בלי לדעת שיש גם קיצור-ביטול תואם (משוב אמיתי ממשתמש).
// טקסט שאלת האישור המלאה (כולל הפועל עצמו, לא רק תוספת) - שונה בין הערוצים:
// - ימות (opts.digitConfirm): בלי "אמרו כן" בכלל - משוב אמיתי ("לא צריך לומר לאשר") - רק הקשה:
//   1=אישור, 2=שינוי (חוזרים לשלב הקודם להזין מחדש), 3=ביטול. הצמתים האלה גם עוברים בפועל למצב
//   הקשה טהור (tap, בלי המתנה לזיהוי דיבור כלל) - ר' CONFIRM_MENU_STATES ב-routes/yemot.js.
// - Twilio (אין הקשות מוגדרות שם): נשאר הניסוח המקורי, בלי שינוי.
function confirmMenuText(opts) {
  return opts && opts.digitConfirm
    ? "לאישור הקישו 1, לשינוי הקישו 2, לביטול הקישו 3."
    : "אמרו כן לאישור.";
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

// תוקן (ארכיטקטורת שלוחת הקלטה נפרדת בימות): פרמטר "phone" חדש, אופציונלי (ר' routes/yemot.js) -
// נשמר בעמודה ייעודית (לא רק בתוך draft_json) כדי לאפשר לאתר מחדש שיחה לפי מספר טלפון, למקרה
// ש-ApiCallId משתנה כשימות מעבירה שיחה בין שלוחות. גם מעדכן תמיד updated_at, כדי שאפשר יהיה למצוא
// "שיחה שהתחילה לפני רגע" (ולא שיחה ישנה באותו מספר) - ר' reattachRecordingCall ב-routes/yemot.js.
function upsertCall(callSid, userId, state, draft, outcome, phone) {
  const existing = db.prepare("SELECT id FROM call_logs WHERE call_sid = ?").get(callSid);
  if (existing) {
    db.prepare(
      "UPDATE call_logs SET user_id = COALESCE(?, user_id), state = ?, draft_json = ?, outcome = COALESCE(?, outcome), phone = COALESCE(?, phone), updated_at = datetime('now') WHERE call_sid = ?"
    ).run(userId || null, state, JSON.stringify(draft || {}), outcome || null, phone || null, callSid);
  } else {
    db.prepare(
      "INSERT INTO call_logs (call_sid, user_id, state, draft_json, outcome, phone, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run(callSid, userId || null, state, JSON.stringify(draft || {}), outcome || null, phone || null);
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
  CONFIRM_MENU_STATES,
  DIGIT_MENU_STATES,
  parseSpokenEmail, // מיוצא כדי לאפשר בדיקה ישירה (ר' tests/test-flow.js) - בלי לעבור זרימת שיחה מלאה
  extractAmount, // מיוצא כדי לאפשר בדיקה ישירה (ר' tests/test-flow.js) - כולל פענוח מספרים במילים
};
