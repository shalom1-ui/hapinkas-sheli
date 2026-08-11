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

// משמיע טקסט ומבקש קלט בזיהוי דיבור (stt), עם שם ערך קבוע ("speech").
// opts.freeText: true עבור שלבים שמבקשים טקסט חופשי גרידא (כמו שם תלמיד, שם מלא בהרשמה) שאין
// בהם שום קיצור הקשה (ספרה/סולמית) בעל משמעות ממילא. במצב הרגיל (voice) אי אפשר לכוון כמה זמן
// שקט נחשב "סיימו לדבר" (quiet_max) - זה קבוע מראש אצל ימות ולא בשליטתנו, ולפי בדיקה בפועל זה
// גורם לפעמים לחתוך שם דו-מילתי (כמו "יוסף לוי") בין המילים ולהחזיר "לא זוהה דיבור". במצב freeText
// עוברים למנוע "הקלטה" (records recognition engine) של ימות, שבו כן אפשר לכוון quiet_max - נותנים
// מרווח נדיב יותר (3 שניות שקט) לפני שנחשב שסיימו לדבר, ומגבילים אורך הקלטה ל-10 שניות.
// המחיר: הקשת ספרות/סולמית תוך כדי ההשמעה נחסמת אוטומטית במצב הזה (מגבלה של ימות עצמו, לא שלנו) -
// לכן משתמשים בזה רק בשלבים שאין בהם בכלל קיצור הקשה שימושי (ר' FREE_TEXT_STATES ב-routes/yemot.js).
function sayAndReadStt(text, opts = {}) {
  const safe = sanitizeForYemot(text);
  if (opts.freeText) {
    const ops = ["no", "voice", "", "", "", "3", "10", "record"];
    return `read=t-${safe}=${VAL_NAME},${ops.join(",")}`;
  }
  // סדר האופציות (ראו תיעוד מודול ה-API): valName, re_enter_if_exists, 'voice', lang, block_typing,
  // max_digits, quiet_max, max_length, use_records_recognition_engine - משאירים ריק = ברירת מחדל (עברית)
  return `read=t-${safe}=${VAL_NAME},no,voice,,,,,,,`;
}

// משמיע טקסט ומבקש מימות להקליט את קול המתקשר לקובץ גולמי (מצב "record") - בניגוד ל-sayAndReadStt,
// כאן ימות לא מנסה בכלל לזהות מה נאמר; היא רק שומרת הקלטה. אנחנו מורידים ומתמללים אותה בעצמנו
// אח"כ באמצעות Whisper (ר' services/speechToText.js) - זה בשימוש רק כשמוגדר "זיהוי דיבור משודרג"
// (ר' README), ורק בשלבים חסרי-קיצור-הקשה (כמו שם תלמיד) כי מצב record חוסם הקשות לגמרי בזמן ההשמעה.
// path/fileName נקבעים מראש ע"י הקורא (ר' speechToText.recordingPath) כדי שנדע בוודאות איפה לחפש
// את ההקלטה בהמשך, בלי להסתמך על הערך שימות מחזירה (שהפורמט המדויק שלו לא מתועד באופן רשמי אצלנו).
function sayAndRecord(text, path, fileName) {
  const safe = sanitizeForYemot(text);
  // סדר האופציות: valName, re_enter_if_exists, 'record', path, file_name, no_confirm_menu (יש לבקש
  // "no" כדי *לדלג* על תפריט "לאישור ההקלטה הקישו..." של ימות ולעבור ישר הלאה), save_on_hangup
  // (yes - כדי שגם אם המתקשר מנתק מיד אחרי שאמר את השם, ההקלטה עדיין נשמרת), append_to_existing_file
  // (לא רלוונטי - כל הקלטה כאן היא קובץ חדש), min_length, max_length (בשניות - 15 שניות מספיק בנדיבות
  // לשם או תשובה קצרה, מבלי להשאיר את המתקשר מחכה יותר מדי אם הוא שקט).
  const ops = ["no", "record", path, fileName, "no", "yes", "", "", "15"];
  return `read=t-${safe}=${VAL_NAME},${ops.join(",")}`;
}

// משמיע טקסט ומבקש הקשת קוד ספרות קבוע-אורך במקלדת הטלפון (מצב "tap" של ימות) - משמש לקוד PIN בן
// 4 ספרות (ר' routes/ivr.js, signup_pin). שונה לגמרי ממצב stt/voice: כאן ימות לא מנסה בכלל לזהות
// דיבור, רק סופרת הקשות מקלדת עד שמגיעים בדיוק ל-digits ספרות, ואז ממשיכה אוטומטית (בלי לחכות
// ל-# ובלי להקריא את הספרות בחזרה בקול - typing_playback_mode="No" - חשוב לפרטיות, כדי שקוד ה-PIN
// לא יישמע בקול תוך כדי ההקשה למי שנמצא ליד המתקשר).
function sayAndReadDigits(text, digits) {
  const safe = sanitizeForYemot(text);
  // סדר האופציות (מצב tap, ר' תיעוד מודול ה-API): valName, re_enter_if_exists, max_digits, min_digits,
  // sec_wait (שניות המתנה בין הקשות - 7 שניות, נדיב אבל לא מוגזם), typing_playback_mode, block_asterisk_key,
  // block_zero_key, replace_char, digits_allowed, amount_attempts, allow_empty, empty_val, block_change_keyboard.
  const ops = ["no", String(digits), String(digits), "7", "No", "no", "no", "", "", "", "", "", ""];
  return `read=t-${safe}=${VAL_NAME},${ops.join(",")}`;
}

// משמיע טקסט ואז מנתק את השיחה (למסכי סיום)
function sayAndHangup(text) {
  const safe = sanitizeForYemot(text);
  return `id_list_message=t-${safe}.g-hangup`;
}

module.exports = { sayAndReadStt, sayAndRecord, sayAndReadDigits, sayAndHangup, sanitizeForYemot, VAL_NAME };
