// yemot.js — שכבת הטלפוניה מול "ימות המשיח" (קו IVR2 בקול כשר, גישת מפתחים דרך מודול API).
// אחראית על בניית מחרוזות התגובה שהפרוטוקול של ימות מצפה להן.
//
// איך זה עובד (בקצרה, מבוסס תיעוד ציבורי + קוד המקור של הספרייה yemot-router2):
//   1) בכל שלב בשיחה, מערכת ימות שולחת בקשת HTTP (GET/POST) לכתובת ה-API שהגדרנו בשלוחה (ext.ini: type=api).
//      הבקשה כוללת שדות קבועים: ApiCallId (מזהה קבוע לאורך כל השיחה), ApiPhone (מספר המתקשר), ApiDID, ApiExtension,
//      ובנוסף כל ערך שביקשנו מהמתקשר בשלב הקודם (למשל "speech").
//   2) אנחנו עונים במחרוזת טקסט פשוטה (לא JSON/XML) בפורמט מיוחד:
//        - "read=t-<טקסט>=<שם_ערך>,no,voice,,,,,,," -> משמיע טקסט (TTS) ומבקש קלט בזיהוי דיבור (stt)
//        - "id_list_message=t-<טקסט>.g-hangup"      -> משמיע טקסט ואז מנתק
//   3) בשיחה הבאה (אותו ApiCallId) הערך שהמתקשר אמר יגיע בשדה "speech" בבקשה.
//
// אנחנו לא מתקינים את חבילת yemot-router2 כתלות (npm) כדי לשמור על עקרון "בלי ספריות חיצוניות" של הפרויקט -
// זו מימוש-יד מינימלי לאותו פרוטוקול, באותה רוח כמו telephony.js (Twilio).
"use strict";

// שם הערך הקבוע שבו נבקש מימות לשמור את מה שהמתקשר אמר - כדי שלא נצטרך לעקוב אחרי שמות דינמיים
const VAL_NAME = "speech";

// ימות אוסר תווים מסויימים בטקסט TTS (הם משמשים כתווי בקרה בפרוטוקול עצמו) - מסירים אותם בעדינות
function sanitizeForYemot(text) {
  return String(text || "").replace(/[.\-"'&|]/g, "");
}

// משמיע טקסט ומבקש קלט בזיהוי דיבור (stt), עם שם ערך קבוע ("speech")
function sayAndReadStt(text) {
  const safe = sanitizeForYemot(text);
  // סדר האופציות (ראו תיעוד מודול ה-API): valName, re_enter_if_exists, 'voice', lang, block_typing,
  // max_digits, quiet_max, max_length, use_records_recognition_engine - משאירים ריק = ברירת מחדל (עברית)
  return `read=t-${safe}=${VAL_NAME},no,voice,,,,,,,`;
}

// משמיע טקסט ואז מנתק את השיחה (למסכי סיום)
function sayAndHangup(text) {
  const safe = sanitizeForYemot(text);
  return `id_list_message=t-${safe}.g-hangup`;
}

module.exports = { sayAndReadStt, sayAndHangup, sanitizeForYemot, VAL_NAME };
