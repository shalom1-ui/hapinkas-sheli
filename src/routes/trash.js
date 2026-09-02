// trash.js — נתיבי "סל מחזור": רשימה, שחזור, מחיקה לצמיתות. ר' src/lib/trash.js להסבר הגישה
// הגנרית, ו-README.md ("סל מחזור") לרשימה המלאה של מה שמכוסה.
"use strict";
const fs = require("fs");
const path = require("path");
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");
const { restoreRow } = require("../lib/trash");

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "..", "..", "data", "uploads");
// מסמכים שנמחקים לא נמחקים מהדיסק בפועל - עוברים לתיקיית "סל מחזור" נפרדת (ר' routes/documents.js) -
// כדי שאפשר יהיה להחזיר גם את הקובץ עצמו, לא רק את שורת המטא-דאטה ב-DB.
const TRASH_UPLOADS_DIR = path.join(UPLOADS_DIR, "_trash");

function register(router) {
  // רשימת פריטים בסל המחזור של המשתמש המחובר - רק תקציר לתצוגה (לא ה-JSON המלא), מהחדש לישן.
  router.get("/api/trash", requireAuth(async (ctx) => {
    const rows = db
      .prepare("SELECT id, entity_type, summary, deleted_at FROM trash WHERE user_id = ? ORDER BY id DESC LIMIT 300")
      .all(ctx.user.userId);
    return json(ctx.res, 200, { items: rows });
  }));

  // שחזור פריט - מחזיר את השורה (או כל השורות, למחיקת קובץ ייבוא שלם) לטבלה המקורית שלה, עם מזהה
  // חדש (לא בהכרח אותו id כמו לפני המחיקה - הישן אולי כבר "נתפס" ע"י שורה אחרת שנוצרה בינתיים).
  router.post("/api/trash/:id/restore", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM trash WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "הפריט לא נמצא בסל המחזור" });
    const data = JSON.parse(row.data);

    if (row.entity_type === "import_batch") {
      for (const r of data) restoreRow(row.table_name, r);
    } else if (row.entity_type === "student") {
      // התלמיד עצמו מעולם לא נמחק בפועל (ר' routes/students.js - "מחיקה" שם היא רק active=0) -
      // "שחזור" הוא סתם החזרת הדגל, לא INSERT (השורה כבר קיימת, עם אותו id בדיוק).
      db.prepare("UPDATE students SET active = 1 WHERE id = ?").run(data.id);
    } else if (row.entity_type === "document") {
      // מחזירים קודם את הקובץ הפיזי בחזרה למקומו המקורי (מהתיקייה הנפרדת שאליה הוא "עבר" במחיקה,
      // ר' routes/documents.js) - ורק אז את שורת המטא-דאטה, כדי שאם מישהו יקרא GET מיד אחרי השחזור
      // הקובץ כבר יהיה שם.
      const trashPath = path.join(TRASH_UPLOADS_DIR, data.file_path);
      const restoredPath = path.join(UPLOADS_DIR, data.file_path);
      try {
        if (fs.existsSync(trashPath)) {
          fs.mkdirSync(path.dirname(restoredPath), { recursive: true });
          fs.renameSync(trashPath, restoredPath);
        }
      } catch (e) {
        return json(ctx.res, 500, { error: `שחזור הקובץ מהדיסק נכשל: ${e.message}` });
      }
      restoreRow(row.table_name, data);
    } else {
      restoreRow(row.table_name, data);
    }

    db.prepare("DELETE FROM trash WHERE id = ?").run(row.id);
    return json(ctx.res, 200, { message: "שוחזר בהצלחה" });
  }));

  // מחיקה לצמיתות מסל המחזור (בלי שחזור) - למסמך, מוחקת גם את הקובץ הפיזי מתיקיית ה"סל מחזור".
  router.delete("/api/trash/:id", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM trash WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "הפריט לא נמצא בסל המחזור" });
    if (row.entity_type === "document") {
      const data = JSON.parse(row.data);
      const trashPath = path.join(TRASH_UPLOADS_DIR, data.file_path);
      try { if (fs.existsSync(trashPath)) fs.unlinkSync(trashPath); } catch (e) { /* לא קריטי */ }
    }
    db.prepare("DELETE FROM trash WHERE id = ?").run(row.id);
    return json(ctx.res, 200, { message: "נמחק לצמיתות" });
  }));

  // ריקון כל סל המחזור בבת אחת (משאיר את כל הקבצים הפיזיים שנמחקו כבר - כמו DELETE בודד לכל אחד)
  router.post("/api/trash/empty", requireAuth(async (ctx) => {
    const rows = db.prepare("SELECT * FROM trash WHERE user_id = ? AND entity_type = 'document'").all(ctx.user.userId);
    for (const row of rows) {
      const data = JSON.parse(row.data);
      const trashPath = path.join(TRASH_UPLOADS_DIR, data.file_path);
      try { if (fs.existsSync(trashPath)) fs.unlinkSync(trashPath); } catch (e) { /* לא קריטי */ }
    }
    const info = db.prepare("DELETE FROM trash WHERE user_id = ?").run(ctx.user.userId);
    return json(ctx.res, 200, { deleted: info.changes });
  }));
}

module.exports = { register, TRASH_UPLOADS_DIR };
