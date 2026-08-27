// weddingTransactions.js — תקציב חתונה: אזור נפרד לגמרי מהתנועות הרגילות (routes/transactions.js).
// משוב אמיתי ממשתמש: "שיהיה קטגוריה נפרדת להוצאות חתונה, הכנסות מתרומות... אזור נפרד לגמרי בשם
// 'חתונה'". קטגוריות ההוצאה קבועות מראש ולא טקסט חופשי (מלבד "אחר") - כי המשתמש פירט רשימה מדויקת,
// כולל פירוט לפי יום לשבע ברכות ("שבע ברכות יש 6 ימים, ושבת - שבת ברכות").
// בנוסף (בניגוד לתנועות הרגילות, שם אפשר רק למחוק) - כאן אפשר גם *לערוך* תנועה קיימת בפועל (PUT),
// לפי משוב מפורש: "שאוכל לערוך ולשנות" מתייחס לעריכת תנועה שכבר הוזנה.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");
const { rememberPhrase, getDictionary } = require("../lib/dictionary");

const WEDDING_EXPENSE_CATEGORIES = [
  "ביגוד", "אולם חתונה",
  "שבע ברכות - יום 1", "שבע ברכות - יום 2", "שבע ברכות - יום 3",
  "שבע ברכות - יום 4", "שבע ברכות - יום 5", "שבע ברכות - יום 6",
  "שבת ברכות",
  "קייטרינג", "מוזיקה", "שמלת כלה", "אירוסין", "מתנות", "אביזרים לדירה", "ביגוד לילדים",
];
const WEDDING_INCOME_CATEGORIES = ["תרומות"];

function register(router) {
  // רשימת קטגוריות קבועות (ל-select באתר) + מילון "אחר" מותאם-אישית (כמו בתנועות הרגילות)
  router.get("/api/wedding/categories", requireAuth(async (ctx) => {
    return json(ctx.res, 200, {
      expense: WEDDING_EXPENSE_CATEGORIES,
      income: WEDDING_INCOME_CATEGORIES,
    });
  }));

  router.get("/api/wedding/dictionary", requireAuth(async (ctx) => {
    const kind = ctx.query.type === "income" ? "wedding_income_category_other" : "wedding_expense_category_other";
    return json(ctx.res, 200, { phrases: getDictionary(ctx.user.userId, kind) });
  }));

  router.get("/api/wedding/transactions", requireAuth(async (ctx) => {
    const rows = db
      .prepare("SELECT * FROM wedding_transactions WHERE user_id = ? ORDER BY occurred_at DESC, id DESC")
      .all(ctx.user.userId);
    const income = rows.filter(r => r.type === "income").reduce((s, r) => s + r.amount, 0);
    const expense = rows.filter(r => r.type === "expense").reduce((s, r) => s + r.amount, 0);
    const byCategory = {};
    for (const r of rows) {
      if (r.type !== "expense") continue;
      const cat = r.category || "אחר";
      byCategory[cat] = (byCategory[cat] || 0) + r.amount;
    }
    return json(ctx.res, 200, {
      transactions: rows,
      summary: { income, expense, balance: income - expense },
      byCategory,
    });
  }));

  router.post("/api/wedding/transactions", requireAuth(async (ctx) => {
    const { type, amount, category, note } = ctx.body;
    if (!["income", "expense"].includes(type)) {
      return json(ctx.res, 400, { error: "סוג תנועה חייב להיות income או expense" });
    }
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) return json(ctx.res, 400, { error: "יש להזין סכום תקין" });

    const info = db
      .prepare("INSERT INTO wedding_transactions (user_id, type, amount, category, note) VALUES (?, ?, ?, ?, ?)")
      .run(ctx.user.userId, type, numAmount, category || null, note || null);

    // קטגוריית "אחר" חופשית נכנסת למילון האישי הנפרד של החתונה, בדיוק כמו "אחר" בתנועות הרגילות -
    // כדי שתוצע שוב בפעם הבאה, בלי להתערבב עם מילון הקטגוריות הרגיל (kind נפרד).
    if (category && !WEDDING_EXPENSE_CATEGORIES.includes(category) && !WEDDING_INCOME_CATEGORIES.includes(category)) {
      rememberPhrase(ctx.user.userId, type === "income" ? "wedding_income_category_other" : "wedding_expense_category_other", category);
    }

    const row = db.prepare("SELECT * FROM wedding_transactions WHERE id = ?").get(info.lastInsertRowid);
    return json(ctx.res, 201, { transaction: row });
  }));

  // עריכת תנועה קיימת - משוב אמיתי: "שאוכל לערוך ולשנות" (בניגוד לתנועות הרגילות, שם אפשר רק למחוק
  // ולהוסיף מחדש). מעדכן רק שדות שנשלחו בפועל בבקשה (עדכון חלקי).
  router.put("/api/wedding/transactions/:id", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM wedding_transactions WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "תנועה לא נמצאה" });

    const type = ctx.body.type !== undefined ? ctx.body.type : row.type;
    if (!["income", "expense"].includes(type)) return json(ctx.res, 400, { error: "סוג תנועה חייב להיות income או expense" });
    const amount = ctx.body.amount !== undefined ? Number(ctx.body.amount) : row.amount;
    if (!amount || amount <= 0) return json(ctx.res, 400, { error: "יש להזין סכום תקין" });
    const category = ctx.body.category !== undefined ? (ctx.body.category || null) : row.category;
    const note = ctx.body.note !== undefined ? (ctx.body.note || null) : row.note;

    db.prepare("UPDATE wedding_transactions SET type = ?, amount = ?, category = ?, note = ? WHERE id = ?")
      .run(type, amount, category, note, row.id);

    if (category && !WEDDING_EXPENSE_CATEGORIES.includes(category) && !WEDDING_INCOME_CATEGORIES.includes(category)) {
      rememberPhrase(ctx.user.userId, type === "income" ? "wedding_income_category_other" : "wedding_expense_category_other", category);
    }

    const updated = db.prepare("SELECT * FROM wedding_transactions WHERE id = ?").get(row.id);
    return json(ctx.res, 200, { transaction: updated });
  }));

  router.delete("/api/wedding/transactions/:id", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM wedding_transactions WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "תנועה לא נמצאה" });
    db.prepare("DELETE FROM wedding_transactions WHERE id = ?").run(row.id);
    return json(ctx.res, 200, { message: "התנועה נמחקה" });
  }));
}

module.exports = { register, WEDDING_EXPENSE_CATEGORIES, WEDDING_INCOME_CATEGORIES };
