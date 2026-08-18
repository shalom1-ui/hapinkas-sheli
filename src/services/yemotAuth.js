// yemotAuth.js — ניסיון (שנכשל, ר' להלן) להשתמש ב-API של ימות המשיח בשם "DoubleAuth" בתור אימות
// טלפוני חינמי לכל מספר טלפון של משתמש באפליקציה שלנו (למשל למפקח שמצהיר על עצמו, או לשחזור סיסמה).
//
// **סטטוס סופי - לא בשימוש**: נבדק מול קו אמיתי (2026-08-18) והתקבלה השגיאה:
//   {"responseStatus":"Exception","message":"unable to authenticate in AUTH_TOKEN session",
//    "file":"DoubleAuth.ym","Line":"15:63"}
// לאחר בדיקה נוספת בתיעוד הציבורי (פורום מפתחי ימות), התברר שה-API הזה **לא מיועד למה שחשבנו**:
// הוא משמש לאבטחה של ההתחברות (Login) של בעל החשבון עצמו ל-API של ימות (session-based, נוצר דרך
// שירות ה-Login עם שם משתמש+סיסמה) - כלומר "אימות דו-שלבי" על ההתחברות של המפתח/בעל הקו למערכת
// ימות עצמה, ולא שירות כללי לשליחת שיחת-אימות לכל מספר טלפון שנרצה (כמו Twilio Verify). הטוקן
// הקבוע (YEMOT_API_TOKEN, בפורמט טלפון:סיסמה) שאנחנו כבר משתמשים בו ל-Whisper אינו מסוג הסשן
// שה-DoubleAuth דורש - זה בדיוק תואם למה שכתוב בתיעוד: "שימוש בטוקן שהוא שם משתמש וסיסמה של
// המערכת לא מומלץ לעבודה עם מתודות שדורשות אימות דו שלבי".
//
// המסקנה המעשית: **אין דרך חינמית** (דרך ימות) לשלוח שיחת-אימות לטלפון של משתמש קצה באפליקציה
// שלנו. האפשרויות שנשארות: (1) מייל אמיתי בחינם דרך SendGrid (services/email.js - כבר עובד),
// (2) שיחה טלפונית אמיתית דרך Twilio (בתשלום, ר' README), (3) המשך עבודה במצב MOCK לטלפון (הקוד
// מוצג על המסך, בסדר לבדיקות/פיתוח, לא מומלץ לפרודקשן בלי מעקב).
//
// הקוד כאן נשאר קיים לצורך תיעוד ולמקרה שימות יפתחו בעתיד API אמיתי לשימוש הזה, אבל **הוא כבר לא
// נקרא משום מקום** (recoveryChannel.js הוסר ממנו הקריאה) - isConfigured() עדיין עובד כרגיל לפי
// משתני הסביבה, אבל שום דבר לא קורא לו יותר בפועל.
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
