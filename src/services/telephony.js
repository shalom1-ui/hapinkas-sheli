// telephony.js — שכבת הטלפוניה. אחראית על:
//   1) בניית מסמכי TwiML (ה-XML שמנחה את Twilio מה להגיד/להקשיב) — עובד תמיד, גם ב-MOCK.
//   2) ביצוע שיחות יוצאות אמיתיות (למשל להקראת קוד שחזור סיסמה) — פעיל רק בייצור עם פרטי Twilio אמיתיים.
//
// למה Twilio ולא חיבור נפרד ל-Google Speech-to-Text?
// התג <Gather input="speech" language="he-IL"> של Twilio מבצע זיהוי דיבור בעצמו ומחזיר את התמלול
// ישירות בשדה SpeechResult בבקשת ה-Webhook הבאה. זה חוסך בניית תשתית הזרמת אודיו (WebSocket) נפרדת
// אל Google Cloud Speech, ומצמצם את כל האינטגרציה לספק אחד (Twilio) בלבד — פשוט יותר וזול יותר להרצה.
"use strict";

const MOCK_MODE = process.env.TWILIO_MOCK !== "false";

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// אומר משפט ומיד מנתק (למסכי סיום שיחה)
function sayAndHangup(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="he-IL" voice="Google.he-IL-Wavenet-A">${escapeXml(text)}</Say>
  <Hangup/>
</Response>`;
}

// אומר משפט ומאזין לתגובה קולית חופשית (לא לחיצת מקשים), עם הפניה חזרה לנתיב actionPath
function sayAndGather({ text, actionPath, hints = [], timeoutSeconds = 5 }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="he-IL" speechTimeout="auto" timeout="${timeoutSeconds}"
          action="${escapeXml(actionPath)}" method="POST"
          hints="${escapeXml(hints.join(","))}">
    <Say language="he-IL" voice="Google.he-IL-Wavenet-A">${escapeXml(text)}</Say>
  </Gather>
  <Say language="he-IL" voice="Google.he-IL-Wavenet-A">לא שמעתי תשובה. מתקשרים לשיחה מחדש בבקשה.</Say>
  <Hangup/>
</Response>`;
}

// אומר משפט ומאזין להקשת מקלדת (DTMF) בלבד - לא לזיהוי דיבור. משמש לקוד PIN בן 4 ספרות (ר'
// routes/ivr.js, signup_pin) - הקשת מקלדת אמינה בהרבה מזיהוי דיבור לספרות (ולא נשמעת ע"י מי
// שנמצא ליד המתקשר, בניגוד לאמירת קוד בקול). ה-Gather עוצר אוטומטית ברגע ש-numDigits הוקשו, בלי
// לחכות ל-# - הספרות מגיעות בבקשה הבאה בשדה "Digits" (לא "SpeechResult").
function sayAndGatherDigits({ text, actionPath, numDigits = 4, timeoutSeconds = 10 }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="${numDigits}" timeout="${timeoutSeconds}"
          action="${escapeXml(actionPath)}" method="POST">
    <Say language="he-IL" voice="Google.he-IL-Wavenet-A">${escapeXml(text)}</Say>
  </Gather>
  <Say language="he-IL" voice="Google.he-IL-Wavenet-A">לא זיהיתי הקשה. מתקשרים לשיחה מחדש בבקשה.</Say>
  <Hangup/>
</Response>`;
}

// מקריא קוד שחזור סיסמה בשיחה יוצאת (בלי SMS) — בלב הפיצ'ר "שחזור סיסמה בשיחה קולית"
function codeReadoutTwiml(code) {
  const spacedCode = String(code).split("").join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="he-IL" voice="Google.he-IL-Wavenet-A">שלום, קוד האימות שלך לשחזור הסיסמה הוא: ${spacedCode}. שוב, הקוד הוא: ${spacedCode}. תודה.</Say>
</Response>`;
}

// ביצוע שיחה יוצאת אמיתית דרך Twilio REST API (משמש לשחזור סיסמה קולי)
async function placeOutboundCallWithCode({ to, code }) {
  if (MOCK_MODE) {
    console.log(`[MOCK][Twilio] הייתה מתבצעת שיחה יוצאת אל ${to} המקריאה את הקוד ${code}`);
    return { ok: true, mock: true };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL; // כתובת ציבורית של השרת שלנו, כדי ש-Twilio יוכל להגיע ל-TwiML
  if (!sid || !token || !fromNumber || !publicBaseUrl) {
    throw new Error("חסרים פרטי Twilio אמיתיים בסביבה (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER/PUBLIC_BASE_URL)");
  }

  // Twilio Voice API יכול לקבל TwiML ישירות דרך פרמטר Twiml, כך שאין צורך באחסון קובץ נפרד
  const twiml = codeReadoutTwiml(code);
  const params = new URLSearchParams({ To: to, From: fromNumber, Twiml: twiml });

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
    },
    body: params,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`שגיאת Twilio: ${data.message || res.status}`);
  return { ok: true, callSid: data.sid };
}

module.exports = { sayAndHangup, sayAndGather, sayAndGatherDigits, codeReadoutTwiml, placeOutboundCallWithCode, escapeXml };
