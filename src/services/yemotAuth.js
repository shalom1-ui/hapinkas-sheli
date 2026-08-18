// yemotAuth.js — אימות טלפוני חינמי דרך ה-API של ימות המשיח, בלי Twilio ובלי לענות לשיחה בכלל:
// "שיחת אימות" (DoubleAuth בתיעוד ימות) - ימות מבצעים שיחה יוצאת למספר המבוקש; 4 הספרות האחרונות
// של המספר המתקשר (Caller ID) הן קוד האימות - המתקשר רק צריך להביט בשיחה שהתקבלה (גם בלי לענות
// לה בכלל) ולהקליד/להקריא בחזרה את 4 הספרות. חינמי לגמרי כי אין חיוג שנענה בפועל - זה משתמש באותו
// חשבון ימות שכבר קיים ומשולם עליו ממילא (ר' YEMOT_API_TOKEN, כבר מוגדר לצורך Whisper).
//
// שונה מהותית מ-services/recoveryChannel.js (Twilio/מייל): שם המערכת שלנו קובעת מראש מהו הקוד,
// והערוץ רק "מקריא" אותו. כאן ההפך - ימות עצמם קובעים את הקוד (הוא נגזר מהמספר המתקשר), ולכן גם
// אימות הקוד (VerifyCode) מתבצע מול ימות, לא מול קוד ששמרנו בעצמנו ב-DB - ר' שילוב זה ב-routes/auth.js
// (השדה verify_via בטבלאות password_resets/admin_claim_requests).
//
// **סטטוס**: מבוסס על תיעוד ציבורי (פורום מפתחי ימות) של API בשם "DoubleAuth" (action=SendCode /
// action=VerifyCode) - טרם נבדק מול קו אמיתי, ושמות הפרמטרים המדויקים לא אומתו רשמית. אם זה לא
// עובד בבדיקה חיה, יש לבדוק את לוגי ה-[YEMOT-AUTH-DEBUG] (מציגים בדיוק מה ימות מחזירים) ולהתאים -
// בדיוק כמו שקרה עם שלוחת ההקלטה ל-Whisper כשנבנתה לראשונה (ר' README). כדי לכבות זמנית ולחזור
// למצב הקודם (MOCK/Twilio) - ר' recoveryChannel.js, שנופל אוטומטית חזרה אם SendCode לא מצליח.
"use strict";

const YEMOT_API_BASE = "https://www.call2all.co.il/ym/api/";

function isConfigured() {
  return !!(process.env.YEMOT_API_TOKEN && process.env.YEMOT_EXTENSION_NUMBER);
}

// מבקשים מימות לבצע שיחת אימות למספר הנתון. מחזיר true רק אם ימות אישרו בבירור שהשיחה יצאה בפועל.
async function sendCallerIdCode(phone) {
  if (!isConfigured()) return false;
  try {
    const url = `${YEMOT_API_BASE}DoubleAuth?token=${encodeURIComponent(process.env.YEMOT_API_TOKEN)}&action=SendCode&phone=${encodeURIComponent(phone)}`;
    const res = await fetch(url);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* ימות לפעמים מחזירים טקסט לא-JSON למקרי שגיאה */ }
    console.log(`[YEMOT-AUTH-DEBUG] SendCode(${phone}) -> ${text}`);
    return !!(data && String(data.responseStatus || "").toUpperCase().startsWith("OK"));
  } catch (e) {
    console.log(`[YEMOT-AUTH-DEBUG] SendCode(${phone}) נכשל: ${e.message}`);
    return false;
  }
}

// שולחים לימות את 4 הספרות שהמתקשר הקריא בחזרה, ונותנים לימות עצמם להחליט אם זה תואם למה ששלחו.
async function verifyCallerIdCode(phone, code) {
  if (!isConfigured()) return false;
  try {
    const url = `${YEMOT_API_BASE}DoubleAuth?token=${encodeURIComponent(process.env.YEMOT_API_TOKEN)}&action=VerifyCode&phone=${encodeURIComponent(phone)}&code=${encodeURIComponent(code)}`;
    const res = await fetch(url);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* כנ"ל */ }
    console.log(`[YEMOT-AUTH-DEBUG] VerifyCode(${phone}, ${code}) -> ${text}`);
    return !!(data && String(data.responseStatus || "").toUpperCase().startsWith("OK"));
  } catch (e) {
    console.log(`[YEMOT-AUTH-DEBUG] VerifyCode(${phone}, ${code}) נכשל: ${e.message}`);
    return false;
  }
}

module.exports = { isConfigured, sendCallerIdCode, verifyCallerIdCode };
