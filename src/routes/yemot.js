// yemot.js (routes) — Webhook עבור קו "ימות המשיח" (שלוחת API, ext.ini: type=api).
// זהו אותו מנוע שיחה בדיוק כמו routes/ivr.js (Twilio) - שם מכונות המצבים advance()/advanceSignup()
// מיובאות משם - רק שכבת התרגום לפרוטוקול שונה: כאן עונים במחרוזות הפרוטוקול של ימות
// (services/yemot.js) במקום TwiML.
//
// זרימה טיפוסית מול ימות המשיח:
//   1) שיחה נכנסת -> ימות שולח POST עם ApiCallId (קבוע לאורך כל השיחה) ו-ApiPhone (מספר המתקשר)
//   2) מזהים משתמש לפי מספר טלפון: אם ידוע - שואלים לאיזו קטגוריה להיכנס; אם לא - מציעים הרשמה
//      ישירות בטלפון (advanceSignup, בדיוק כמו ב-Twilio)
//   3) ימות שולח POST נוסף עם אותו ApiCallId + השדה "speech" (מה שהמתקשר אמר, מזוהה ע"י ימות)
//   4) טוענים את מצב השיחה השמור (call_logs, לפי call_sid=ApiCallId), מתקדמים במכונת המצבים, עונים הלאה
//   5) חוזר חלילה עד לתשובת "id_list_message=...hangup" שמנתקת את השיחה
"use strict";

const db = require("../db");
const { text, json } = require("../router");
const { advance, advanceSignup, upsertCall, appendTranscript, MAIN_MENU_HINTS, mainMenuPrompt, OPENING_GREETING, DIGIT_ENTRY_STATES } = require("./ivr");
const { sayAndReadStt, sayAndGoToRecordExtension, sayAndReadDigits, sayAndHangup, VAL_NAME } = require("../services/yemot");
const speechToText = require("../services/speechToText");
const debugLog = require("../debugLog");

// שלבים שמבקשים טקסט חופשי גרידא (שם, לא קטגוריה/ספרה) - אין בהם שום קיצור הקשה בעל משמעות,
// ולכן אפשר להעביר אותם למנוע ה"הקלטה" של ימות (freeText ב-sayAndReadStt) לזיהוי דיבור מדויק
// ונדיב יותר, בלי לפגוע בקיצורי ההקשה בשום מקום אחר (הם ממילא לא רלוונטיים כאן).
// כשמוגדר "זיהוי דיבור משודרג" (speechToText.isConfigured() - ר' services/speechToText.js), אותם
// שלבים בדיוק עוברים למצב "record" גולמי + תמלול Whisper במקום מנוע ההקלטה-לזיהוי של ימות עצמו -
// ר' הערות בהמשך הקובץ במקומות שבהם נבדק FREE_TEXT_STATES.
//
// "main_menu" נוסף כאן בעקבות תקלות חוזרות בפועל: התפריט הראשי (בחירת קטגוריה, שם/מילים כמו "ניהול
// חשבונות") הוא בדיוק המקום שבו מנוע הזיהוי המקורי של ימות נכשל הכי הרבה ("לא זוהה דיבור" שוב ושוב),
// כי המילים ארוכות/מורכבות יחסית. המחיר: **רק** במצב שבו Whisper מוגדר בפועל, הקשת ספרה בתפריט
// הראשי (1-6, ר' MAIN_MENU_DIGIT_KEYWORDS) מפסיקה לעבוד, כי מצב "הקלטה" חוסם הקשות לגמרי - ר' opts.menuVoiceOnly
// ב-mainMenuPrompt (routes/ivr.js) שמסיר גם את ההזכרה המילולית של האפשרות הזו במצב הזה, כדי לא להטעות.
// "balance_next_action" נוסף בעקבות משוב אמיתי: אחרי קריאת יתרה (ר' doBalance ב-routes/ivr.js), שואלים
// אם להוסיף הכנסה/הוצאה - שלב עם גם מילים חופשיות וגם קיצורי הקשה (1/2), בדיוק כמו main_menu.
// "signup_email_speak" נוסף בעקבות משוב אמיתי נוסף: בעבר "signup_email" היה רק בחירת ספק בהקשה
// (1/2/0) עם כתובת מזויפת שנבנתה אוטומטית מהשם - זה בלבל, כי זו לא כתובת אמיתית (ר' הערה מפורטת
// ב-routes/ivr.js, פונקציית parseSpokedEmail/case "signup_email_speak"). עכשיו מבקשים מהמתקשר
// להכתיב את הכתובת האמיתית שלו בקול, ולכן זה חייב לעבור דרך אותו מנגנון תמלול Whisper מדויק.
// "expense_amount"/"income_amount" נוספו בעקבות משוב אמיתי נוסף ("אמרתי 100 ש"ח והוא לא זיהה") -
// עד עכשיו סכומים זוהו רק דרך מנוע הזיהוי המובנה (הלא-משודרג) של ימות, בדיוק כמו שהיה עם התפריט
// הראשי לפני שעבר ל-Whisper - ואין בהם שום קיצור הקשה קיים היום שהיה נשבר (ר' extractAmount
// ב-routes/ivr.js גם לרשת ביטחון נוספת: פענוח מספר שנאמר במילים, "מאה" ולא רק "100").
// תוקן (משוב אמיתי ממשתמש: "אותו הדבר תעשה בכל הקטגוריות") - אותה בעיה (מנוע זיהוי מובנה חלש) קיימת
// עקרונית בכל שלב שמצפה לתשובה חופשית/שם ולא רק להקשת ספרה, אז מרחיבים לכל השלבים כאלה:
// - "expense_category": קטגוריית הוצאה חופשית (מזון/תחבורה/דיור/אחר) - בלי קיצור הקשה קיים בכלל.
// - "therapist_role": בחירת סוג דיווח (ריפוי בעיסוק/רגשי/אחר) - בלי קיצור הקשה, ובניגוד ל-main_menu
//   אין כאן אפילו "לא הבנתי, נסו שוב" בקלט לא מזוהה (נופל בשקט ל"אחר") - כך שדיוק התמלול קריטי יותר.
// - "therapist_student"/"supervisor_pick_student": התאמת שם תלמיד חופשי - אותו דפוס בדיוק כמו
//   mentor_pick_student (שכבר ב-FREE_TEXT_STATES), רק בזרימות אחרות (דיווח מטפל/הערת מפקח).
// - "guardian_pick_child": התאמת שם ילד חופשי מתוך רשימה (הורה עם כמה ילדים) - אותו דפוס שוב.
// - "therapist_note"/"supervisor_readback": תוכן חופשי וארוך יותר (דיווח/הערה, לא רק מילה אחת) -
//   **חשוב**: אלה עלולים להיות ארוכים מכמה שניות בודדות, ולכן דורשים גם הגדלה של אורך ההקלטה
//   המרבי בהגדרת שלוחת ההקלטה בימות (option_record) מ-15 שניות ל-60 - ר' README, "הגדרת שלוחת
//   ההקלטה" - **שינוי הגדרות חובה בצד ימות לפני שזה יעבוד טוב לשדות הארוכים האלה**, אחרת דיווח/הערה
//   ארוכים עלולים להיחתך. שדות קצרים (שם/קטגוריה/סכום) לא מושפעים לרעה מההגדלה - הם ממילא נגמרים
//   מוקדם יותר בגלל זיהוי 3 השניות השקט.
// "signup_email_offer"/"signup_email_confirm" **לא** כאן בכוונה - אלה שלבי כן/לא רגילים (בדיוק כמו
// expense_confirm וכו'), לא טקסט חופשי. גם transactions_pick_type/mentor_action/mentor_confirm_add_student
// **לא** כאן בכוונה - יש בהם קיצורי הקשה עובדים ואמינים (1/2/3/4) שהיו נחסמים במצב "הקלטה".
// "mentor_note_speak" נוסף בעקבות בקשת פיצ'ר: דיווח מעקב חופשי על מפגש חונכות (בדיוק אותו note
// אופציונלי שכבר קיים באתר, ר' routes/students.js checkout/quick-session) - עכשיו אפשר להכתיב אותו
// גם בטלפון, מיד אחרי checkout/מפגש רגיל (ר' offerMentorNote/case "mentor_note_speak" ב-routes/ivr.js).
// **גם הוא** תוכן חופשי וארוך יותר (כמו therapist_note/supervisor_readback) - כפוף לאותה דרישת
// עדכון option_record ל-3-1-60 שכבר תועדה למעלה. "mentor_note_offer"/"mentor_note_confirm" **לא**
// כאן בכוונה - אלה שלבי כן/לא רגילים עם קיצור הקשה 1/2 אמין, בדיוק כמו signup_email_offer/confirm.
// "expense_category_other" נוסף בעקבות משוב אמיתי נוסף ("כשאני אומר אחר, המערכת צריכה להציע דיבור
// חופשי ושזה יישמר לפעם הבאה") - תיאור חופשי של קטגוריה מותאמת-אישית (ר' case "expense_category"/
// "expense_category_other" ב-routes/ivr.js) - אותו סוג תוכן בדיוק כמו expense_category, רק שלב נוסף.
const FREE_TEXT_STATES = new Set([
  "signup_name", "mentor_pick_student", "main_menu", "balance_next_action",
  "signup_email_speak", "expense_amount", "income_amount",
  "expense_category", "therapist_role", "therapist_student", "supervisor_pick_student",
  "guardian_pick_child", "therapist_note", "supervisor_readback", "mentor_note_speak",
  "expense_category_other",
]);

// תוקן (באג אמיתי שהתגלה בבדיקה חיה - ר' הערה מפורטת ב-speechToText.transcribeAudio): "רמז אוצר
// מילים" ל-Whisper, לפי השלב הנוכחי בשיחה - מוטה את התמלול לכיוון עברית ולכיוון המילים הצפויות
// באמת בשלב הזה. הכי משמעותי בתפריט הראשי, ששם יש רשימת מילים סגורה וידועה מראש (קטגוריות) -
// זה בדיוק השלב שבו נצפתה "הזיה" של תמלול בכתב לא-עברי (לטיני/קירילי/ערבי) לגמרי חסר משמעות.
function vocabularyHintFor(state) {
  if (state === "main_menu" || state === "balance_next_action") return "ניהול חשבונות, תנועות, חונכות, מטפלים, הורה, הערת מפקח, הכנסה, הוצאה";
  if (state === "signup_name" || state === "mentor_pick_student") return "שם פרטי ושם משפחה בעברית, לדוגמה: שלום כהן, דוד לוי, רחל אברהם";
  // "דלג" נוסף לרמז בכוונה (ר' README/ הערה ב-routes/ivr.js ליד case "signup_email_retry"): בבדיקה
  // בפועל התברר שרמז מוטה כולו לכיוון מילות כתובת מייל עלול "למשוך" את Whisper להזות משהו אחר גם
  // כשבפועל נאמרה רק מילת דילוג קצרה - הוספת המילה עצמה לרמז אמורה להקטין את הסיכוי לזה.
  if (state === "signup_email_speak") return "כתובת אימייל, שטרודל, כרוכית, נקודה, ג'ימייל, אאוטלוק, הוטמייל, או דלג";
  if (state === "expense_amount" || state === "income_amount") return "סכום כסף בשקלים, מספרים, לדוגמה: מאה שקלים, מאתיים וחמישים, חמישים שקל";
  if (state === "expense_category") return "קטגוריית הוצאה, לדוגמה: מזון, תחבורה, דיור, בריאות, חינוך, ביגוד, אחר";
  if (state === "expense_category_other") return "שם קטגוריית הוצאה מותאמת אישית, לדוגמה: תרופות, מתנות, תיקונים";
  if (state === "therapist_role") return "סוג דיווח מקצועי: ריפוי בעיסוק, טיפול רגשי, או אחר";
  if (state === "therapist_student" || state === "supervisor_pick_student" || state === "guardian_pick_child") {
    return "שם פרטי ושם משפחה בעברית, לדוגמה: שלום כהן, דוד לוי, רחל אברהם";
  }
  // "therapist_note"/"supervisor_readback" - תוכן חופשי וארוך יותר (לא שם/מילה בודדת) - בכוונה בלי
  // רמז אוצר מילים ספציפי (רמז מוטה מדי עלול "למשוך" תוכן ארוך וחופשי לכיוון לא נכון, ר' ההערה
  // ב-signup_email_speak על התופעה הזו בדיוק) - משאירים את Whisper חופשי לתמלל בלי הטיה.
  return undefined;
}

// בונה את תגובת הפרוטוקול לבקשת קלט טקסט חופשי (שם וכו') עבור שלב נתון - בוחר בין שתי אפשרויות:
// (1) אם מוגדר זיהוי דיבור משודרג (Whisper) - מעבירים את השיחה זמנית לשלוחת ההקלטה הנפרדת
//     (sayAndGoToRecordExtension, ר' services/yemot.js) שתשמור את ההקלטה ותחזיר את השיחה אלינו;
//     (2) אחרת - מנוע ה"הקלטה-לזיהוי" הרגיל של ימות (freeText), כמו קודם.
// תוקן (שינוי ארכיטקטורה נוסף - "הקלטה נפרדת", ר' README/CHANGELOG): הניסיון הקודם - להקליט "בתוך"
// שלוחת ה-API עצמה (read=...,record,...) - מעולם לא הצליח בפועל. הפתרון הנוכחי מעביר בפועל את
// השיחה לשלוחה אחרת (type=record) שמוגדרת בממשק הניהול של ימות - ר' README - ולכן אין יותר צורך
// בהנחיה "הקישו X לאישור" כאן: האישור/הקישה קורים כבר **בתוך** שלוחת ההקלטה עצמה (לפי הגדרת
// record_ok שם), לפני שהשיחה חוזרת אלינו בכלל.
const RECORD_CONFIRM_HINT = "";

// דגל בקרה למצב ה"הקלטה נפרדת + Whisper" (ר' README, סעיף "זיהוי דיבור משודרג"). מופעל רק אם גם
// המפתחות מוגדרים (ר' speechToText.isConfigured, כולל YEMOT_RECORD_EXTENSION) וגם הדגל כאן מופעל -
// כך שאפשר להשאיר את המפתחות מוגדרים בסביבת הייצור (Render) בלי חשש, וכל הבקרה על הפעלה/כיבוי
// בפועל היא רק דרך הדגל הזה, בלי צריך לגעת במשתני הסביבה.
const WHISPER_RECORD_MODE_ENABLED = true;

function whisperRecordModeActive() {
  return WHISPER_RECORD_MODE_ENABLED && speechToText.isConfigured();
}

// מייצר draft חדש לשמירה: אם עוברים למצב שדורש הקלטה נפרדת (whisper מופעל) - מסמנים
// "_recording: true" כדי שכשהשיחה תחזור אלינו משלוחת ההקלטה (ר' reattachRecordingCall/הבדיקה
// בתחילת הטיפול בבקשה למטה) נדע לתמלל את ההקלטה במקום להתייחס לשדה "speech" הרגיל. אם לא -
// מוודאים שהדגל הזה לא נשאר דלוק בטעות משלב קודם.
function withRecordingFlag(draft, active) {
  const d = { ...(draft || {}) };
  if (active) {
    d._recording = true;
  } else {
    delete d._recording;
  }
  return d;
}

function freeTextPrompt(callId, text_) {
  if (whisperRecordModeActive()) {
    const recordExt = process.env.YEMOT_RECORD_EXTENSION;
    return sayAndGoToRecordExtension(`${text_}${RECORD_CONFIRM_HINT}`, recordExt);
  }
  return sayAndReadStt(text_, { freeText: true });
}

// תוקן (ארכיטקטורת שלוחת הקלטה נפרדת): לא מתועד במפורש אם ApiCallId נשאר זהה אחרי שימות מעבירה
// שיחה (go_to_folder) לשלוחת ההקלטה וחזרה (record_end_goto) - ייתכן שימות "פותחת" שיחה חדשה
// מבחינתה ושולחת ApiCallId חדש. כרשת ביטחון: אם לא נמצאה שיחה קיימת לפי ApiCallId החדש, מחפשים
// שיחה אחרונה מאותו מספר טלפון שסומנה כ"ממתינה להקלטה" (_recording:true) ועודכנה לאחרונה (בתוך
// 90 שניות) - ואם נמצאה, "מאמצים" אותה: משנים את call_sid שלה ל-ApiCallId החדש, כאילו זו אותה שיחה
// מההתחלה. אם ApiCallId בכל זאת נשאר זהה (הארכיטקטורה "מתנהגת יפה") - הפונקציה הזו פשוט לא תמצא
// כלום ולא משנה שום התנהגות קיימת.
//
// תוקן (באג אמיתי שהתגלה בבדיקה חיה - ר' README): בגרסה הראשונה, הפונקציה הזו הופעלה על **כל**
// בקשה שלא נמצאה לה שיחה - כולל בקשת "פתיחת שיחה" הראשונה של חיוג חדש לגמרי (ApiExtension ריק).
// זה גרם לתקלה מבלבלת: כשמתקשר ניתק באמצע (למשל תוך כדי שהשיחה עדיין "תקועה" עם _recording:true),
// וחייג שוב תוך פחות מ-3 דקות - הבקשה הראשונה של החיוג ה**חדש** (ApiExtension ריק, לא קשור בכלל
// לשלוחת ההקלטה) "אומצה" בטעות לתוך השיחה הישנה והתקועה, במקום להתחיל שיחה חדשה נקייה עם ברכת
// פתיחה רגילה - מה שנראה למתקשר כאילו "המערכת לא ממשיכה" (כי בפועל היא ניסתה לתמלל הקלטה ישנה
// במקום להשמיע ברכה). התיקון: (1) קוראים לפונקציה הזו רק כשיש ApiExtension בבקשה (כלומר זו לא
// בקשת הפתיחה הראשונה של חיוג - ר' הקריאה למטה); (2) בכל ניתוק (hangup=yes) מנקים את הדגל
// _recording מהשיחה הפעילה (ר' למטה) כדי ששיחה שנגמרה לעולם לא תאומץ בטעות ע"י חיוג עתידי.
function reattachRecordingCall(callId, phone) {
  const candidates = phoneCandidates(phone);
  if (!candidates.length) return null;
  const placeholders = candidates.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT * FROM call_logs WHERE phone IN (${placeholders}) AND draft_json LIKE '%"_recording":true%' AND updated_at >= datetime('now', '-90 seconds') ORDER BY updated_at DESC LIMIT 1`
    )
    .get(...candidates);
  if (!row) return null;
  db.prepare("UPDATE call_logs SET call_sid = ?, updated_at = datetime('now') WHERE id = ?").run(callId, row.id);
  console.log(`[YEMOT-DEBUG] אימוץ שיחה קיימת (id=${row.id}) תחת ApiCallId חדש (${callId}) לפי מספר טלפון - ApiCallId כנראה השתנה במעבר בין שלוחות`);
  return { ...row, call_sid: callId };
}

// מנקה את דגל "_recording" משיחה שמסתיימת (ר' הערה מפורטת ב-reattachRecordingCall למעלה) - כדי
// ששיחה שהמתקשר ניתק ממנה תוך כדי שהיא "ממתינה להקלטה" לעולם לא תיאמץ בטעות לתוך חיוג עתידי חדש.
function clearRecordingFlagOnHangup(callId) {
  const row = db.prepare("SELECT draft_json FROM call_logs WHERE call_sid = ?").get(callId);
  if (!row) return;
  const draft = JSON.parse(row.draft_json || "{}");
  if (!draft._recording) return;
  delete draft._recording;
  db.prepare("UPDATE call_logs SET draft_json = ?, updated_at = datetime('now') WHERE call_sid = ?").run(JSON.stringify(draft), callId);
}

function register(router) {
  router.post("/api/ivr/yemot", async (ctx) => {
    const v = ctx.body || {};
    // לוג אבחון זמני: רושם בדיוק מה ימות שולח בכל בקשה (כולל השדה "speech" - שם מגיעה גם הקשת ספרות/
    // סולמית תוך כדי זיהוי דיבור) - כדי לבדוק בפועל (דרך "Logs" ב-Render) מה בדיוק קורה כשמקישים
    // סולמית בודדת. אפשר להסיר את השורה הזו בהמשך אחרי שהעניין יתברר.
    console.log(`[YEMOT-DEBUG] בקשה נכנסת: ${JSON.stringify(v)}`);
    const callId = v.ApiCallId;

    // בקשה שלא מגיעה מימות (בדיקה ידנית בדפדפן וכו') - לא מחזירים שגיאה קשה, רק הודעה ברורה
    if (!callId) {
      return text(ctx.res, 200, "בקשה זו אינה בקשת ימות המשיח תקינה (חסר ApiCallId)");
    }

    // המתקשר ניתק - אין מה להשיב. גם מנקים את דגל _recording אם היה דלוק (ר' clearRecordingFlagOnHangup
    // למעלה) - כדי שהשיחה הזו לעולם לא תיאמץ בטעות ע"י חיוג חדש עתידי מאותו מספר.
    if (v.hangup === "yes") {
      clearRecordingFlagOnHangup(callId);
      return text(ctx.res, 200, "");
    }

    let call = db.prepare("SELECT * FROM call_logs WHERE call_sid = ?").get(callId);

    // אם לא נמצאה שיחה לפי ApiCallId החדש - ייתכן שזו בכלל שיחה קיימת שחזרה משלוחת ההקלטה עם
    // ApiCallId שונה (ר' הערה מפורטת ב-reattachRecordingCall למעלה). מנסים לאמץ אותה לפי טלפון
    // לפני שמתייחסים לזה כאילו זו שיחה חדשה לגמרי. תוקן (באג אמיתי): מנסים לאמץ **רק** אם יש
    // ApiExtension בבקשה - בקשת ה"פתיחה" הראשונה של חיוג חדש לגמרי (ApiExtension ריק) לעולם לא
    // אמורה להיות ניסיון "חזרה" משלוחת הקלטה, ולכן לא בודקים אותה מול שיחות ישנות בכלל.
    if (!call && v.ApiExtension) {
      call = reattachRecordingCall(callId, v.ApiPhone);
    }

    // ---------- תחילת שיחה חדשה: מזהים משתמש לפי מספר טלפון ----------
    if (!call) {
      const whisperOn = whisperRecordModeActive();
      const user = findUserByPhone(v.ApiPhone);
      if (!user) {
        upsertCall(callId, null, "signup_name", withRecordingFlag({ phone: v.ApiPhone }, whisperOn), null, v.ApiPhone);
        return text(
          ctx.res,
          200,
          freeTextPrompt(callId, `${OPENING_GREETING}מספר הטלפון שלך אינו מזוהה במערכת. אפשר להירשם עכשיו ישירות בטלפון, בלי לגשת לאתר. מה השם המלא שלכם?`)
        );
      }

      upsertCall(callId, user.id, "main_menu", withRecordingFlag({}, whisperOn), null, v.ApiPhone);
      const menuVoiceOnly = whisperOn;
      return text(
        ctx.res,
        200,
        freeTextPrompt(callId, `${OPENING_GREETING}${mainMenuPrompt(user.full_name, { digitConfirm: true, menuVoiceOnly })}`)
      );
    }

    // ---------- המשך שיחה קיימת ----------
    const draft = JSON.parse(call.draft_json || "{}");
    let speech = String(v[VAL_NAME] || "").trim();
    // אם draft._recording דלוק - השלב הקודם העביר את השיחה לשלוחת ההקלטה הנפרדת (ר' freeTextPrompt/
    // withRecordingFlag), וזו הבקשה שמגיעה בחזרה משם (record_end_goto). השדה "speech" בבקשה הזו
    // הוא לא דיבור שזוהה בכלל - במקום זאת מורידים ומתמללים בעצמנו את ההקלטה האחרונה ששמורה בשלוחת
    // ההקלטה (ר' services/speechToText.js). אם התמלול נכשל מכל סיבה - מתייחסים לזה כאילו לא נשמע
    // כלום (speech ריק), כדי שהלוגיקה הרגילה של "לא שמעתי, נסו שוב" תיכנס לפעולה - בלי לקבל זבל כתשובה.
    if (draft._recording) {
      delete draft._recording;
      if (whisperRecordModeActive()) {
        const transcribed = await speechToText.downloadAndTranscribe(vocabularyHintFor(call.state));
        if (transcribed) {
          console.log(`[WHISPER-DEBUG] שימוש בתמלול Whisper במקום זיהוי הדיבור של ימות: "${transcribed}"`);
          speech = transcribed;
        } else {
          console.log("[WHISPER-DEBUG] תמלול נכשל/לא זמין - מתייחסים לכך כאילו לא נשמע דיבור");
          speech = "";
        }
      } else {
        // Whisper כובה בינתיים תוך כדי שהמתקשר היה בשלוחת ההקלטה - מצב קצה נדיר, לא סומכים על
        // "speech" הגולמי (הוא לא טקסט אמיתי מבחינת שלוחת record) ומתייחסים לזה כאילו לא נשמע כלום.
        speech = "";
      }
    }
    appendTranscript(callId, speech);

    // digitConfirm: true - בימות אפשר להקיש (כולל סולמית) תוך כדי זיהוי דיבור בלי לחסום את זה
    // (ר' services/yemot.js / sayAndReadStt), אז מוסיפים אפשרות אישור מהירה בהקשה בכל שאלת "אמרו כן לאישור".
    // menuVoiceOnly: ר' הערה מפורטת ב-mainMenuPrompt (routes/ivr.js) - רק כשזה true מוסתרת ההזכרה
    // המילולית של הקשת 1-6 בתפריט הראשי (כי היא לא זמינה במצב הקלטה של Whisper); לשאר שאלות האישור
    // בשיחה (שאינן מצב הקלטה) זה לא משפיע - הן ממשיכות להשתמש ב-digitConfirm הרגיל.
    const opts = { digitConfirm: true, menuVoiceOnly: whisperRecordModeActive() };
    const result = call.user_id
      ? await advance(call.state, speech, draft, db.prepare("SELECT * FROM users WHERE id = ?").get(call.user_id), opts)
      : await advanceSignup(call.state, speech, draft, opts);

    const goingToFreeText = !result.hangup && !DIGIT_ENTRY_STATES.has(result.nextState) && FREE_TEXT_STATES.has(result.nextState);
    const draftToSave = withRecordingFlag(result.draft || draft, goingToFreeText && whisperRecordModeActive());

    upsertCall(callId, result.newUserId || call.user_id, result.nextState, draftToSave, result.outcome, v.ApiPhone);

    if (result.hangup) {
      return text(ctx.res, 200, sayAndHangup(result.text));
    }
    if (DIGIT_ENTRY_STATES.has(result.nextState)) {
      return text(ctx.res, 200, sayAndReadDigits(result.text, 4));
    }
    if (FREE_TEXT_STATES.has(result.nextState)) {
      return text(ctx.res, 200, freeTextPrompt(callId, result.text));
    }
    return text(ctx.res, 200, sayAndReadStt(result.text));
  });

  // --- אבחון זמני: בדיקת הקלטות Whisper ישירות מול ימות (ר' README, סעיף "זיהוי דיבור משודרג") ---
  // נועד לענות סופית על השאלה "האם ההקלטה בכלל נשמרת אצל ימות, ואיפה בדיוק" - בלי להסתמך על ניווט
  // ידני מבלבל באתר הניהול של ימות (שקשה להסביר צעד-אחר-צעד למשתמש לא-טכני). קורא ל-API הרשמי
  // GetIVR2Dir של ימות (עם הטוקן שכבר מוגדר אצלנו כמשתנה סביבה) ומחזיר את רשימת הקבצים שנמצאים
  // בפועל בתיקיית שלוחת ההקלטה הנפרדת (ר' services/speechToText.js, findLatestRecording).
  // מוגן במילת-מעבר קבועה בפרמטר key בכתובת (לא סוד אמיתי - רק כדי שלא כל מי שמנחש את הכתובת
  // יוכל לראות רשימת קבצים) - יש להסיר את הנתיב הזה אחרי שהתקלה תיפתר.
  const DEBUG_KEY = "hapinkas-diag-9427";
  router.get("/api/debug/yemot-dir", async (ctx) => {
    if (ctx.query.key !== DEBUG_KEY) {
      return json(ctx.res, 403, { error: "אין הרשאה - חסר או שגוי פרמטר key" });
    }
    if (!process.env.YEMOT_API_TOKEN) {
      return json(ctx.res, 400, { error: "חסר משתנה סביבה YEMOT_API_TOKEN" });
    }
    const ext = process.env.YEMOT_EXTENSION_NUMBER || "";
    const targetPath = ctx.query.path || ext || "/";
    try {
      const url = `https://www.call2all.co.il/ym/api/GetIVR2Dir?token=${encodeURIComponent(process.env.YEMOT_API_TOKEN)}&path=${encodeURIComponent(targetPath)}`;
      const yemotRes = await fetch(url);
      const rawText = await yemotRes.text();
      let data;
      try { data = JSON.parse(rawText); } catch { data = { rawResponse: rawText }; }
      return json(ctx.res, 200, {
        checkedPath: targetPath,
        yemotExtensionEnv: ext,
        httpStatus: yemotRes.status,
        yemotResponse: data,
      });
    } catch (e) {
      return json(ctx.res, 500, { error: e.message });
    }
  });

  // --- אבחון זמני, גרסה מהירה: הכל בכתובת אחת ---
  // במקום "תתקשר -> תיכנס ל-Render -> תצלם מסך של Logs -> תשלח" בכל פעם, מסך אחד שמראה גם את
  // שורות ה-[YEMOT-DEBUG]/[WHISPER-DEBUG] האחרונות (מ-debugLog, ר' שם) וגם את רשימת הקבצים
  // העדכנית בתיקיית השלוחה (GetIVR2Dir) - טקסט פשוט שאפשר להעתיק-להדביק ישירות, בלי צילום מסך.
  router.get("/api/debug/yemot-recent", async (ctx) => {
    if (ctx.query.key !== DEBUG_KEY) {
      return json(ctx.res, 403, { error: "אין הרשאה - חסר או שגוי פרמטר key" });
    }
    const lines = debugLog.getAll();
    const logsText = lines.length
      ? lines.map((e) => `${e.time}  ${e.line}`).join("\n")
      : "(אין עדיין שורות אבחון בזיכרון - יתאפסו אחרי כל פריסה/הפעלה מחדש של השרת; תתקשר קודם ואז תרענן את הדף הזה)";

    let filesText = "(לא נבדק - חסר YEMOT_API_TOKEN)";
    if (process.env.YEMOT_API_TOKEN) {
      const ext = process.env.YEMOT_EXTENSION_NUMBER || "";
      const targetPath = ctx.query.path || ext || "/";
      try {
        const url = `https://www.call2all.co.il/ym/api/GetIVR2Dir?token=${encodeURIComponent(process.env.YEMOT_API_TOKEN)}&path=${encodeURIComponent(targetPath)}`;
        const yemotRes = await fetch(url);
        const rawText = await yemotRes.text();
        filesText = rawText;
      } catch (e) {
        filesText = `שגיאה בבדיקת קבצים: ${e.message}`;
      }
    }

    // מצב הגדרות התכונות האופציונליות - כדי לדעת מרחוק אם EMAIL_MOCK/SENDGRID_API_KEY/EMAIL_FROM
    // (ודומיהם) באמת מוגדרים בפועל ב-Render, בלי לחשוף שום ערך סודי (מפתחות/סיסמאות) - רק true/false
    // אם המשתנה קיים, חוץ מ-EMAIL_FROM שהוא כתובת מייל רגילה ולא סוד. נועד לענות על "גם X לא עובד"
    // בלי שהמשתמש יצטרך להיכנס ל-Render ולצלם מסך של Environment בכל פעם.
    const configText = [
      `EMAIL_MOCK (מייל, ר' README): ${process.env.EMAIL_MOCK === "false" ? "false (מייל אמיתי דרך SendGrid אמור לפעול)" : "לא הוגדר ל-false (עדיין במצב בדיקה - קוד מוצג במסך, שום מייל אמיתי לא נשלח)"}`,
      `SENDGRID_API_KEY: ${process.env.SENDGRID_API_KEY ? "מוגדר (לא מציגים את הערך)" : "חסר"}`,
      `EMAIL_FROM: ${process.env.EMAIL_FROM || "חסר"}`,
      `RECOVERY_MOCK (שיחה קולית): ${process.env.RECOVERY_MOCK === "false" ? "false (Twilio אמיתי אמור לפעול)" : "לא הוגדר ל-false (עדיין במצב בדיקה)"}`,
      `SYSTEM_ADMIN_PASSWORD: ${process.env.SYSTEM_ADMIN_PASSWORD ? "מוגדר (לא מציגים את הערך)" : "חסר"}`,
      `YEMOT_API_TOKEN / YEMOT_EXTENSION_NUMBER: ${process.env.YEMOT_API_TOKEN && process.env.YEMOT_EXTENSION_NUMBER ? "מוגדרים" : "חסרים"}`,
    ].join("\n");

    return text(
      ctx.res,
      200,
      `=== שורות אבחון אחרונות (מהזיכרון, מתאפסות בכל פריסה מחדש) ===\n${logsText}\n\n=== רשימת קבצים נוכחית בשלוחה (GetIVR2Dir) ===\n${filesText}\n\n=== מצב משתני סביבה (בלי ערכים סודיים) ===\n${configText}\n`
    );
  });
}

// ימות שולח את מספר המתקשר לרוב בפורמט מקומי (למשל "0501234567"), בעוד ש-Twilio שולח E.164 (+972501234567).
// כדי שאותו משתמש יזוהה בין שני ספקי הטלפוניה, בודקים כמה צורות כתיבה נפוצות של אותו מספר.
function findUserByPhone(rawPhone) {
  const candidates = phoneCandidates(rawPhone);
  for (const candidate of candidates) {
    const user = db.prepare("SELECT * FROM users WHERE phone = ? OR phone2 = ?").get(candidate, candidate);
    if (user) return user;
  }
  return null;
}

function phoneCandidates(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D/g, "");
  if (!digits) return [];
  const local = digits.startsWith("972") ? "0" + digits.slice(3) : digits; // 972501234567 -> 0501234567
  const noLeadingZero = local.replace(/^0/, ""); // 0501234567 -> 501234567
  return Array.from(
    new Set([rawPhone, digits, local, `+972${noLeadingZero}`, `972${noLeadingZero}`, local])
  ).filter(Boolean);
}

module.exports = { register };
