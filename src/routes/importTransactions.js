// importTransactions.js — "ייבוא אקסל" של דפי בנק/כרטיס אשראי לתוך הכנסות/הוצאות. משוב אמיתי
// ממשתמש: "רוצה להכניס אקסל של דפי בנק או דפי כרטיס אשראי, שיוכל להוריד אותו והמערכת תכניס את זה
// להכנסות והוצאות". שני שלבים בכוונה, בדיוק כמו יבוא כספי בכל מערכת רצינית - אף פעם לא שומרים
// תנועות ישירות מקובץ בלי שהמשתמש ראה ואישר אותן קודם (זה כסף אמיתי, טעות קריאה בעמודה הלא נכונה
// יכולה ליצור תנועות שגויות רבות בבת אחת):
//   (1) POST /api/transactions/import/parse   - מפרק את הקובץ, מזהה עמודות, מחזיר תצוגה מקדימה. לא שומר כלום.
//   (2) POST /api/transactions/import/commit  - שומר תנועות שהמשתמש אישר/ערך בתצוגה המקדימה. מדלג
//       אוטומטית על תנועות שכבר יובאו בעבר (ר' import_hash), כדי שאפשר יהיה להעלות את אותו קובץ
//       פעמיים (למשל דף שמכיל גם כמה שורות שכבר יובאו וגם שורות חדשות) בלי ליצור כפילויות.
"use strict";
const crypto = require("crypto");
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");
const { parseXlsx } = require("../lib/xlsxParser");
const { parseCsv } = require("../lib/csvParser");
const { rowsToTransactions } = require("../lib/importMapping");

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_ROWS_PER_IMPORT = 2000; // רשת ביטחון - קובץ תקין של דף בנק/כרטיס לא אמור לחרוג מזה בפועל

function decodeBase64File(data_base64) {
  const base64Only = String(data_base64 || "").includes(",") ? String(data_base64).split(",").pop() : data_base64;
  return Buffer.from(base64Only, "base64");
}

function importHash(userId, t) {
  return crypto.createHash("sha256").update(`${userId}|${t.date}|${t.amount}|${t.type}|${t.description || ""}`).digest("hex");
}

function isXlsxFilename(name) {
  return /\.xlsx$/i.test(String(name || ""));
}
function isCsvFilename(name) {
  return /\.csv$/i.test(String(name || ""));
}

function register(router) {
  // שלב 1: פירוק הקובץ + זיהוי עמודות + החזרת תצוגה מקדימה. לא נוגע במסד הנתונים בכלל.
  router.post("/api/transactions/import/parse", requireAuth(async (ctx) => {
    const { data_base64, filename, source_type } = ctx.body;
    if (!data_base64) return json(ctx.res, 400, { error: "לא התקבל תוכן קובץ (data_base64)" });
    const sourceType = source_type === "card" ? "card" : "bank";

    let buffer;
    try {
      buffer = decodeBase64File(data_base64);
    } catch (e) {
      return json(ctx.res, 400, { error: "תוכן הקובץ אינו base64 תקין" });
    }
    if (!buffer.length) return json(ctx.res, 400, { error: "הקובץ ריק" });
    if (buffer.length > MAX_FILE_BYTES) return json(ctx.res, 400, { error: "הקובץ גדול מדי (מעל 15MB)" });

    // זיהוי סוג הקובץ: לפי סיומת שם הקובץ קודם, ואם לא ברור - לפי "חתימת" הקובץ עצמו (xlsx הוא
    // ארכיון ZIP שתמיד מתחיל בבתים "PK") - כך שגם קובץ בלי סיומת/עם שם משונה עדיין עובד.
    const looksLikeZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    const isXlsx = isXlsxFilename(filename) || (!isCsvFilename(filename) && looksLikeZip);

    let rows;
    try {
      rows = isXlsx ? parseXlsx(buffer) : parseCsv(buffer.toString("utf8"));
    } catch (e) {
      return json(ctx.res, 400, { error: `לא ניתן לקרוא את הקובץ: ${e.message}` });
    }
    if (!rows.length) return json(ctx.res, 400, { error: "לא נמצאו שורות נתונים בקובץ" });
    if (rows.length > MAX_ROWS_PER_IMPORT) {
      return json(ctx.res, 400, { error: `הקובץ מכיל יותר מדי שורות (${rows.length}) - הגבלה של ${MAX_ROWS_PER_IMPORT} שורות לייבוא אחד` });
    }

    const result = rowsToTransactions(rows, sourceType);
    if (result.error) return json(ctx.res, 400, { error: result.error });
    if (!result.transactions.length) {
      return json(ctx.res, 400, { error: "זוהו כותרות עמודות, אבל לא נמצאה אף תנועה תקינה לייבוא בקובץ" });
    }

    // מסמנים לכל תנועה מיד גם אם היא כבר יובאה בעבר (import_hash) - כך שהתצוגה המקדימה יכולה להראות
    // למשתמש "כבר יובא" ולבטל מראש את הסימון שלה, בלי לחכות לניסיון שמירה כפול בשלב commit.
    const existingHashes = new Set(
      db.prepare("SELECT import_hash FROM transactions WHERE user_id = ? AND import_hash IS NOT NULL").all(ctx.user.userId).map(r => r.import_hash)
    );
    const transactions = result.transactions.map(t => ({ ...t, alreadyImported: existingHashes.has(importHash(ctx.user.userId, t)) }));

    return json(ctx.res, 200, {
      transactions,
      skippedRowsCount: result.skippedCount,
      detectedColumns: result.columns,
    });
  }));

  // שלב 2: שמירה בפועל של תנועות שהמשתמש אישר/ערך בתצוגה המקדימה.
  router.post("/api/transactions/import/commit", requireAuth(async (ctx) => {
    const list = Array.isArray(ctx.body.transactions) ? ctx.body.transactions : null;
    if (!list || !list.length) return json(ctx.res, 400, { error: "לא התקבלה רשימת תנועות לייבוא" });
    if (list.length > MAX_ROWS_PER_IMPORT) {
      return json(ctx.res, 400, { error: `יותר מדי תנועות בבקשה אחת (הגבלה של ${MAX_ROWS_PER_IMPORT})` });
    }

    const insert = db.prepare(
      "INSERT INTO transactions (user_id, type, amount, category, note, source, import_hash, occurred_at) VALUES (?, ?, ?, ?, ?, 'import', ?, ?)"
    );
    let imported = 0;
    let skippedDuplicates = 0;
    let skippedInvalid = 0;

    for (const raw of list) {
      const type = raw && (raw.type === "income" || raw.type === "expense") ? raw.type : null;
      const amount = raw ? Number(raw.amount) : NaN;
      const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || "")) ? raw.date : null;
      if (!type || !date || !Number.isFinite(amount) || amount <= 0) { skippedInvalid++; continue; }

      const description = raw.description ? String(raw.description).trim().slice(0, 500) : "";
      const category = raw.category ? String(raw.category).trim().slice(0, 100) : (type === "expense" ? "אחר" : "אחר");
      const t = { date, amount: Math.round(amount * 100) / 100, type, description };
      const hash = importHash(ctx.user.userId, t);

      const exists = db.prepare("SELECT 1 FROM transactions WHERE user_id = ? AND import_hash = ?").get(ctx.user.userId, hash);
      if (exists) { skippedDuplicates++; continue; }

      try {
        insert.run(ctx.user.userId, type, t.amount, category, description || null, hash, `${date} 12:00:00`);
        imported++;
      } catch (e) {
        // התנגשות באינדקס הייחודי (idx_transactions_import_hash, ר' db.js) - מרוץ תזמון נדיר בין
        // ה-SELECT לבדיקת קיום למעלה לבין ה-INSERT בפועל. מתייחסים לזה כמו כפילות רגילה, לא כשגיאה.
        if (/UNIQUE constraint failed/i.test(e.message)) skippedDuplicates++;
        else throw e;
      }
    }

    return json(ctx.res, 201, { imported, skippedDuplicates, skippedInvalid });
  }));
}

module.exports = { register };
