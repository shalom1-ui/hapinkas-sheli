// server.js — נקודת הכניסה לשרת. מריץ שרת HTTP רגיל (מודול http המובנה) עם הראוטר שלנו.
// הפעלה: node src/server.js   (או: npm start)
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Router, json, html } = require("./router");

const router = new Router();

// בדיקת חיים בסיסית — שימושי לבדוק שהשרת עובד, ולניטור אחרי פריסה
router.get("/api/health", async (ctx) => {
  return json(ctx.res, 200, { status: "ok", service: "הפנקס שלי", time: new Date().toISOString() });
});

// האזור האישי הגרפי (ממשק "יפה" ולא-טכני, מיועד גם להראות למשתמשים אחרים/חברים) -
// קובץ סטטי יחיד ב-public/app.html, מוגש ישירות בכתובת הראשית של השרת.
// נקרא מהדיסק בכל בקשה (ולא נשמר בזיכרון) כדי שעדכונים בקובץ ייכנסו לתוקף בלי להפעיל מחדש את השרת.
const APP_HTML_PATH = path.join(__dirname, "..", "public", "app.html");
router.get("/", async (ctx) => {
  try {
    return html(ctx.res, 200, fs.readFileSync(APP_HTML_PATH, "utf8"));
  } catch (e) {
    return json(ctx.res, 500, { error: "לא נמצא קובץ הממשק (public/app.html)" });
  }
});

require("./routes/auth").register(router);
require("./routes/transactions").register(router);
require("./routes/students").register(router);
require("./routes/reports").register(router);
require("./routes/lessonReports").register(router);
require("./routes/documents").register(router);
require("./routes/subscription").register(router);
require("./routes/ivr").register(router);

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => router.handle(req, res));

server.listen(PORT, () => {
  console.log(`🚀 שרת "הפנקס שלי" פועל על פורט ${PORT}`);
  console.log(`   בדיקת חיים: http://localhost:${PORT}/api/health`);
});

module.exports = server;
