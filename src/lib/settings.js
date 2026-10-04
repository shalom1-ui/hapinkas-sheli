// settings.js — הגדרות מערכת גלובליות שאפשר להפוך בזמן ריצה (טבלת app_settings), בלי פריסה מחדש.
// נוצר בשביל מתג "הקשות בלבד" לקו ימות: כשיתרת זיהוי הדיבור בימות נגמרת, ימות מודיעה "אין יתרה
// בזיהוי דיבור" ולא מקבלת גם הקשות ספרות במצב voice - כלומר אי אפשר להיכנס לקו בכלל. המתג מעביר
// את כל שלבי השיחה שאפשר לעשות בהקשות למצב הקשה (tap) של ימות, שלא משתמש בזיהוי דיבור כלל.
"use strict";
const db = require("../db");

function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  ).run(key, String(value));
}

const KEYPAD_KEY = "yemot_keypad_only";

// משתנה סביבה YEMOT_KEYPAD_ONLY=1 גובר תמיד ("נעילה" ברמת הפריסה) - אחרת קובע המתג שבמסד הנתונים.
function keypadOnlySource() {
  const env = String(process.env.YEMOT_KEYPAD_ONLY || "").toLowerCase();
  if (env === "1" || env === "true") return "env";
  return getSetting(KEYPAD_KEY) === "1" ? "db" : null;
}

function isKeypadOnly() {
  return keypadOnlySource() !== null;
}

function setKeypadOnly(enabled) {
  setSetting(KEYPAD_KEY, enabled ? "1" : "0");
}

module.exports = { getSetting, setSetting, isKeypadOnly, keypadOnlySource, setKeypadOnly };
