// apartmentTransactions.js — תקציב דירה: אזור נפרד לגמרי, באותו דגם בדיוק כמו weddingTransactions.js
// (חתונה נבנתה קודם - ר' שם להסבר המפורט על העיצוב). משוב אמיתי ממשתמש: "כמו שיש הוצאות והכנסות
// יש גם חתונה... אני צריך שיהיה שני קטגוריות נפרדות: 1 חתונה, 2 דירה. בתוך דירה יש שני אפשרויות
// רגיל, תבע משותף" - ותחת "תבע משותף" פירט: עלות בנייה, עלות עו"ד/הסכם, עלות יועץ משכנתאות, עלות
// מיסים. "רגיל" ו"תבע משותף" הם שני מסלולי רכישת דירה שונים לגמרי - "תבע משותף" (רכישה קבוצתית/
// תוכנית בנייה משותפת) מפורט לתת-עלויות, "רגיל" הוא פריט שטוח יחיד (כמו כל שאר הקטגוריות).
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");
const { moveToTrash } = require("../lib/trash");
const { rememberPhrase, getDictionary } = require("../lib/dictionary");

const APARTMENT_EXPENSE_CATEGORIES = [
  "רגיל",
  "תבע משותף - עלות בנייה",
  "תבע משותף - עלות עו\"ד / הסכם",
  "תבע משותף - עלות יועץ משכנתאות",
  "תבע משותף - עלות מיסים",
];
const APARTMENT_INCOME_CATEGORIES = []; // לא צוינו קטגוריות הכנסה קבועות - רק "אחר" חופשי (ר' weddingCategoryOptionsHtml המקביל באתר)

function register(router) {
  router.get("/api/apartment/categories", requireAuth(async (ctx) => {
    return json(ctx.res, 200, {
      expense: APARTMENT_EXPENSE_CATEGORIES,
      income: APARTMENT_INCOME_CATEGORIES,
    });
  }));

  router.get("/api/apartment/dictionary", requireAuth(async (ctx) => {
    const kind = ctx.query.type === "income" ? "apartment_income_category_other" : "apartment_expense_category_other";
    return json(ctx.res, 200, { phrases: getDictionary(ctx.user.userId, kind) });
  }));

  router.get("/api/apartment/transactions", requireAuth(async (ctx) => {
    const rows = db
      .prepare("SELECT * FROM apartment_transactions WHERE user_id = ? ORDER BY occurred_at DESC, id DESC")
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

  router.post("/api/apartment/transactions", requireAuth(async (ctx) => {
    const { type, amount, category, note, loan_id } = ctx.body;
    if (!["income", "expense"].includes(type)) {
      return json(ctx.res, 400, { error: "סוג תנועה חייב להיות income או expense" });
    }
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) return json(ctx.res, 400, { error: "יש להזין סכום תקין" });
    // קישור אופציונלי להלוואה (ר' routes/loans.js) - נבדק שהיא שייכת למשתמש הזה.
    const loanId = loan_id && db.prepare("SELECT id FROM loans WHERE id = ? AND user_id = ?").get(loan_id, ctx.user.userId) ? loan_id : null;

    const info = db
      .prepare("INSERT INTO apartment_transactions (user_id, type, amount, category, note, loan_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ctx.user.userId, type, numAmount, category || null, note || null, loanId);

    if (category && !APARTMENT_EXPENSE_CATEGORIES.includes(category) && !APARTMENT_INCOME_CATEGORIES.includes(category)) {
      rememberPhrase(ctx.user.userId, type === "income" ? "apartment_income_category_other" : "apartment_expense_category_other", category);
    }

    const row = db.prepare("SELECT * FROM apartment_transactions WHERE id = ?").get(info.lastInsertRowid);
    return json(ctx.res, 201, { transaction: row });
  }));

  router.put("/api/apartment/transactions/:id", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM apartment_transactions WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "תנועה לא נמצאה" });

    const type = ctx.body.type !== undefined ? ctx.body.type : row.type;
    if (!["income", "expense"].includes(type)) return json(ctx.res, 400, { error: "סוג תנועה חייב להיות income או expense" });
    const amount = ctx.body.amount !== undefined ? Number(ctx.body.amount) : row.amount;
    if (!amount || amount <= 0) return json(ctx.res, 400, { error: "יש להזין סכום תקין" });
    const category = ctx.body.category !== undefined ? (ctx.body.category || null) : row.category;
    const note = ctx.body.note !== undefined ? (ctx.body.note || null) : row.note;
    const loanId = ctx.body.loan_id !== undefined
      ? (ctx.body.loan_id && db.prepare("SELECT id FROM loans WHERE id = ? AND user_id = ?").get(ctx.body.loan_id, ctx.user.userId) ? ctx.body.loan_id : null)
      : row.loan_id;

    db.prepare("UPDATE apartment_transactions SET type = ?, amount = ?, category = ?, note = ?, loan_id = ? WHERE id = ?")
      .run(type, amount, category, note, loanId, row.id);

    if (category && !APARTMENT_EXPENSE_CATEGORIES.includes(category) && !APARTMENT_INCOME_CATEGORIES.includes(category)) {
      rememberPhrase(ctx.user.userId, type === "income" ? "apartment_income_category_other" : "apartment_expense_category_other", category);
    }

    const updated = db.prepare("SELECT * FROM apartment_transactions WHERE id = ?").get(row.id);
    return json(ctx.res, 200, { transaction: updated });
  }));

  router.delete("/api/apartment/transactions/:id", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM apartment_transactions WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "תנועה לא נמצאה" });
    moveToTrash(ctx.user.userId, "apartment_transaction", "apartment_transactions", `דירה: ${row.category || (row.type === "income" ? "הכנסה" : "הוצאה")} ₪${row.amount}`, row);
    db.prepare("DELETE FROM apartment_transactions WHERE id = ?").run(row.id);
    return json(ctx.res, 200, { message: "התנועה נמחקה" });
  }));

  // מגמה חודשית - משוב אמיתי: "אני רוצה גרף כמו בתנועות רגילות" - אותו דבר בדיוק, על apartment_transactions.
  router.get("/api/apartment/transactions/trend", requireAuth(async (ctx) => {
    const rows = db
      .prepare(
        `SELECT strftime('%Y-%m', occurred_at) AS month,
                SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) AS income,
                SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expense
         FROM apartment_transactions WHERE user_id = ?
         GROUP BY month ORDER BY month DESC LIMIT 12`
      )
      .all(ctx.user.userId);
    return json(ctx.res, 200, { trend: rows.reverse() });
  }));
}

module.exports = { register, APARTMENT_EXPENSE_CATEGORIES, APARTMENT_INCOME_CATEGORIES };
