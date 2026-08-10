// email.js — שירות שליחת מייל כללי. משמש כרגע לעדכון הורים במייל כל פעם שמתקבל דיווח
// התקדמות חדש על הילד שלהם (ר' routes/reports.js).
//
// במצב MOCK (ברירת מחדל): לא נשלח מייל אמיתי - רק מודפס ללוג ומוחזר בתגובת ה-API לצורך בדיקה,
// בדיוק כמו recoveryChannel.js ו-cardcom.js.
//
// במעבר לייצור: יש לבחור ספק מייל (SendGrid / Postmark / Amazon SES / SMTP רגיל וכו') ולהחליף
// את הפונקציה הזו בקריאה אמיתית. שימו לב שזה נפרד לגמרי מהודעות ה-SMS האסורות - זה מייל בלבד.
"use strict";

const MOCK_MODE = process.env.EMAIL_MOCK !== "false";

async function sendEmail({ to, subject, body }) {
  if (!to) return { ok: false, error: "אין כתובת מייל רשומה לנמען" };

  if (MOCK_MODE) {
    console.log(`[MOCK][מייל] אל: ${to} | נושא: ${subject}\n${body}\n`);
    return { ok: true, mock: true, to, subject };
  }

  // TODO(ייצור): שליחה אמיתית. דוגמת שלד ל-SendGrid (לא פעיל כרגע, יש לבחור ספק ולהתקין את פרטי ה-API):
  //   await fetch("https://api.sendgrid.com/v3/mail/send", {
  //     method: "POST",
  //     headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
  //     body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: process.env.EMAIL_FROM }, subject, content: [{ type: "text/plain", value: body }] }),
  //   });
  throw new Error("שליחת מייל אמיתית טרם הוגדרה (לא נבחר ספק) - יש לפעול במצב MOCK בינתיים");
}

module.exports = { sendEmail };
