// debugLog.js — "טבעת" זיכרון פשוטה (בזיכרון בלבד, לא נשמרת בין הפעלות שרת) שאוגרת את שורות הלוג
// האחרונות שמתחילות ב-[YEMOT-DEBUG] או [WHISPER-DEBUG], כדי שאפשר יהיה לראות אותן ישירות מהדפדפן
// דרך /api/debug/yemot-recent (ר' routes/yemot.js) - בלי לצטרך לדפדף/לצלם מסך מתוך Logs של Render
// בכל פעם. נועד במיוחד לתהליך האבחון של תקלת ה-Whisper/ימות, כדי לקצר את הלולאה של "תתקשר -> תיכנס
// ל-Render -> תצלם מסך -> תשלח" לפעולה אחת: "תתקשר -> תפתח קישור אחד -> תעתיק-הדבק".
"use strict";

const MAX_ENTRIES = 200;
const buffer = [];

function push(line) {
  buffer.push({ time: new Date().toISOString(), line: String(line) });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

function getAll() {
  return buffer;
}

function clear() {
  buffer.length = 0;
}

module.exports = { push, getAll, clear };
