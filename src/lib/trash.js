// trash.js — "סל מחזור" גנרי לכל האפליקציה. משוב אמיתי: "אני צריך שיהיה סוג של ספאם במידה ונמחק
// לי שיהיה לי אפשרות להחזיר אותו" (לבירור: כל דבר באפליקציה, כולל קבצי ייבוא/תלמידים/דוחות).
//
// גישה: לא טבלת-צל נפרדת לכל סוג ישות (11 טבלאות שונות למחיקה!) - snapshot יחיד גנרי (JSON) של
// השורה השלמה, ב-db.js/trash. שחזור בונה INSERT דינמי מתוך מפתחות ה-JSON עצמם (לא צריך לדעת/לשכפל
// כאן את רשימת העמודות של כל טבלה בנפרד - עובד על כל טבלה חדשה שתתווסף בעתיד בלי שינוי כאן).
"use strict";
const db = require("../db");

// שומר "צילום" של שורה (או כמה שורות, למשל מחיקת קובץ ייבוא שלם) לפני שהיא נמחקת בפועל.
// tableName תמיד מגיע קבוע מהקוד הקורא (never from ctx.body) - לא סיכון הזרקת SQL.
function moveToTrash(userId, entityType, tableName, summary, data) {
  db.prepare("INSERT INTO trash (user_id, entity_type, table_name, summary, data) VALUES (?, ?, ?, ?, ?)")
    .run(userId, entityType, tableName, summary, JSON.stringify(data));
}

// משחזר שורה בודדת לטבלה שלה - INSERT דינמי מתוך כל השדות שהיו בשורה (חוץ מ-id, כדי לא להתנגש
// עם רשומה שכבר נוצרה בינתיים) - עמודות עם ערך undefined (לא אמורות להיות, אבל ליתר ביטחון) מדולגות.
function restoreRow(tableName, row) {
  const cols = Object.keys(row).filter((k) => k !== "id" && row[k] !== undefined);
  const placeholders = cols.map(() => "?").join(", ");
  const info = db
    .prepare(`INSERT INTO ${tableName} (${cols.join(", ")}) VALUES (${placeholders})`)
    .run(...cols.map((c) => row[c]));
  return info.lastInsertRowid;
}

module.exports = { moveToTrash, restoreRow };
