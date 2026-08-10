// recoveryChannel.js — שליחת קוד שחזור סיסמה: בשיחה קולית (טלפון) או במייל. אף פעם לא ב-SMS.
// במצב MOCK (ברירת מחדל בפיתוח/בדיקות): הקוד לא נשלח באמת, אלא מוחזר בתגובת ה-API כ-demoCode,
// בדיוק כמו שהאב-טיפוס ב-HTML מדגים. כך ניתן לבדוק את כל הזרימה בלי חשבונות Twilio/מייל אמיתיים.
//
// במעבר לייצור:
//  - channel === "phone": יש להחליף את mockSendPhoneCall בקריאה אמיתית ל-Twilio Voice API
//    שמבצעת שיחה יוצאת (outbound call) ל-phone ומקריאה את הקוד (TwiML <Say> בעברית),
//    ר' src/services/telephony.js (ייבנה בשלב ה-IVR) לדוגמת קריאה ל-Twilio REST API בעזרת fetch גלובלי.
//  - channel === "email": יש להחליף את mockSendEmail בשליחה אמיתית דרך ספק מייל
//    (למשל SendGrid/Postmark/SMTP) — טרם נבחר ספק סופי.
"use strict";

const { placeOutboundCallWithCode } = require("./telephony");

const MOCK_MODE = process.env.RECOVERY_MOCK !== "false"; // ברירת מחדל: מצב בדיקה פעיל

async function sendRecoveryCode({ channel, phone, email, code }) {
  const useChannel = channel === "email" ? "email" : "phone";

  if (useChannel === "email") {
    if (!email) return { ok: false, error: "לא קיימת כתובת מייל רשומה למשתמש זה" };
    if (MOCK_MODE) {
      console.log(`[MOCK][מייל] היה נשלח קוד שחזור ${code} אל ${email}`);
      return { ok: true, mock: true, demoCode: code };
    }
    return mockSendEmail({ to: email, code });
  }

  // channel === "phone"
  if (!phone) return { ok: false, error: "לא קיים מספר טלפון רשום למשתמש זה" };
  if (MOCK_MODE) {
    console.log(`[MOCK][שיחה קולית] הייתה מתבצעת שיחה אל ${phone} המקריאה את הקוד ${code}`);
    return { ok: true, mock: true, demoCode: code };
  }
  const result = await placeOutboundCallWithCode({ to: phone, code });
  return { ok: result.ok };
}

async function mockSendEmail({ to, code }) {
  // TODO(ייצור): שליחת מייל אמיתי דרך ספק מייל שטרם נבחר.
  throw new Error("שליחת מייל אמיתית טרם הוגדרה — יש לפעול במצב MOCK בינתיים");
}

module.exports = { sendRecoveryCode };
