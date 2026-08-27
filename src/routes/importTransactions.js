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
const { looksLikeHtml, looksLikeLegacyBinaryXls, parseHtmlTable } = require("../lib/htmlTableParser");
const { parsePdf } = require("../lib/pdfParser");
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

    // זיהוי סוג הקובץ **לפי תוכנו בפועל**, לא (רק) לפי הסיומת - כי בנקים/חברות אשראי רבים בישראל
    // מייצאים "אקסל" שהוא בפועל טבלת HTML פשוטה עם סיומת .xls/.xlsx (Excel פותח את זה בלי בעיה,
    // כי הוא מזהה לפי תוכן - ר' htmlTableParser.js, תוקן בעקבות קובץ אמיתי ("AccountActivity.xls")
    // שהתברר להיות בדיוק כזה). הבדיקה לפי תוכן קודמת לסיומת בכוונה, כדי לתפוס גם קבצים כאלה שנקראים
    // "xlsx" אבל בפועל HTML. xlsx אמיתי הוא תמיד ארכיון ZIP (מתחיל בבתים "PK").
    let rows;
    try {
      if (buffer.length >= 5 && buffer.toString("latin1", 0, 5) === "%PDF-") {
        // ר' src/lib/pdfParser.js - דף חיוב/עו"ש שהורד כ-PDF (למשל דפי כאל, ר' README). זורק שגיאה
        // עברית ברורה בעצמו למקרים לא-נתמכים (מוצפן/סרוק בלי טקסט אמיתי) - לא צריך טיפול נוסף כאן.
        rows = parsePdf(buffer).rows;
      } else if (looksLikeHtml(buffer)) {
        rows = parseHtmlTable(buffer.toString("utf8"));
      } else if (looksLikeLegacyBinaryXls(buffer)) {
        return json(ctx.res, 400, {
          error: "זהו קובץ .xls ישן (בפורמט בינארי של Excel 97-2003) שלא נתמך כרגע. פתחו אותו ב-Excel ושמרו מחדש כ-.xlsx או כ-.csv, ונסו שוב.",
        });
      } else {
        const looksLikeZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
        const isXlsx = isXlsxFilename(filename) || (!isCsvFilename(filename) && looksLikeZip);
        rows = isXlsx ? parseXlsx(buffer) : parseCsv(buffer.toString("utf8"));
      }
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

  // שלב 2: שמירה בפועל של תנועות שהמשתמש אישר/ערך בתצוגה המקדימה. מסמנים את כל התנועות שנשמרות כאן
  // באותו import_batch_id + אותו שם קובץ מקורי, כדי שאפשר יהיה למחוק את כל הקובץ בבת אחת אח"כ
  // (ר' /api/transactions/import/batches למטה - משוב אמיתי: "אם הבאתי דפי בנק ואני רוצה למחוק את
  // הקבצים שהועלו שיהיה אופציה לבחור למחוק מהמערכת").
  router.post("/api/transactions/import/commit", requireAuth(async (ctx) => {
    const list = Array.isArray(ctx.body.transactions) ? ctx.body.transactions : null;
    if (!list || !list.length) return json(ctx.res, 400, { error: "לא התקבלה רשימת תנועות לייבוא" });
    if (list.length > MAX_ROWS_PER_IMPORT) {
      return json(ctx.res, 400, { error: `יותר מדי תנועות בבקשה אחת (הגבלה של ${MAX_ROWS_PER_IMPORT})` });
    }
    const filename = ctx.body.filename ? String(ctx.body.filename).trim().slice(0, 255) : null;
    const batchId = crypto.randomUUID();

    const insert = db.prepare(
      "INSERT INTO transactions (user_id, type, amount, category, note, source, import_hash, import_batch_id, import_filename, occurred_at) VALUES (?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)"
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
        insert.run(ctx.user.userId, type, t.amount, category, description || null, hash, batchId, filename, `${date} 12:00:00`);
        imported++;
      } catch (e) {
        // התנגשות באינדקס הייחודי (idx_transactions_import_hash, ר' db.js) - מרוץ תזמון נדיר בין
        // ה-SELECT לבדיקת קיום למעלה לבין ה-INSERT בפועל. מתייחסים לזה כמו כפילות רגילה, לא כשגיאה.
        if (/UNIQUE constraint failed/i.test(e.message)) skippedDuplicates++;
        else throw e;
      }
    }

    return json(ctx.res, 201, { imported, skippedDuplicates, skippedInvalid, batchId: imported ? batchId : null });
  }));

  // רשימת קבצי ייבוא (אצוות) שנשמרו בפועל - קובץ אחד שהועלה = שורה אחת כאן, גם אם הוא הכיל עשרות
  // תנועות. מוצג ב"תנועות" כדי לאפשר מחיקה של קובץ שלם בלחיצה אחת (ר' /import/batches/:id DELETE למטה).
  router.get("/api/transactions/import/batches", requireAuth(async (ctx) => {
    const rows = db.prepare(
      `SELECT import_batch_id AS batchId, import_filename AS filename, COUNT(*) AS count,
              MIN(occurred_at) AS minDate, MAX(occurred_at) AS maxDate,
              SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) AS income,
              SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expense,
              MAX(id) AS lastId
       FROM transactions WHERE user_id = ? AND import_batch_id IS NOT NULL
       GROUP BY import_batch_id ORDER BY lastId DESC`
    ).all(ctx.user.userId);
    return json(ctx.res, 200, { batches: rows });
  }));

  // מחיקת קובץ ייבוא שלם - כל התנועות שנשמרו יחד תחת אותו import_batch_id, בבת אחת. משוב אמיתי:
  // "אם הבאתי דפי בנק ואני רוצה למחוק את הקבצים שהועלו שיהיה אופציה לבחור למחוק מהמערכת" - עד כה
  // אפשר היה למחוק רק תנועה-תנועה (DELETE /api/transactions/:id), מה שלא מעשי לקובץ עם עשרות שורות.
  router.delete("/api/transactions/import/batches/:batchId", requireAuth(async (ctx) => {
    const info = db.prepare("DELETE FROM transactions WHERE user_id = ? AND import_batch_id = ?").run(ctx.user.userId, ctx.params.batchId);
    if (!info.changes) return json(ctx.res, 404, { error: "קובץ ייבוא לא נמצא" });
    return json(ctx.res, 200, { deleted: info.changes });
  }));
}

module.exports = { register };
