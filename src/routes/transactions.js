// transactions.js — ניהול תקציב אישי: הכנסות/הוצאות, יתרה, פילוח לפי קטגוריה.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");

function register(router) {
  // רשימת תנועות + סיכומים
  router.get("/api/transactions", requireAuth(async (ctx) => {
    const rows = db
      .prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY occurred_at DESC, id DESC")
      .all(ctx.user.userId);

    const income = rows.filter(r => r.type === "income").reduce((s, r) => s + r.amount, 0);
    const expense = rows.filter(r => r.type === "expense").reduce((s, r) => s + r.amount, 0);

    const byCategory = {};
    for (const r of rows) {
      if (r.type !== "expense") continue;
      const cat = r.category || "אחר";
      byCategory[cat] = (byCategory[cat] || 0) + r.amount;
    }

    // מעשרות: המערכת מחשבת אוטומטית 10% מסך ההכנסות כחובת מעשר,
    // ומחסירה מזה כל מה שכבר נרשם כהוצאה תחת הקטגוריה "מעשרות" (לא כולל "צדקה" - זו קטגוריה נפרדת).
    const tithePaid = rows
      .filter(r => r.type === "expense" && r.category === "מעשרות")
      .reduce((s, r) => s + r.amount, 0);
    const titheObligation = Math.round(income * 0.1 * 100) / 100;
    const tithe = {
      obligation: titheObligation,
      paid: tithePaid,
      remaining: Math.round((titheObligation - tithePaid) * 100) / 100,
    };

    return json(ctx.res, 200, {
      transactions: rows,
      summary: { income, expense, balance: income - expense },
      byCategory,
      tithe,
    });
  }));

  // הוספת תנועה (מגיע גם מהאזור האישי וגם מהמנוע הקולי, לכן source ניתן מבחוץ)
  router.post("/api/transactions", requireAuth(async (ctx) => {
    const { type, amount, category, note, source } = ctx.body;
    if (!["income", "expense"].includes(type)) {
      return json(ctx.res, 400, { error: "סוג תנועה חייב להיות income או expense" });
    }
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) return json(ctx.res, 400, { error: "יש להזין סכום תקין" });

    const info = db
      .prepare("INSERT INTO transactions (user_id, type, amount, category, note, source) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ctx.user.userId, type, numAmount, category || null, note || null, source === "phone" ? "phone" : "web");

    const row = db.prepare("SELECT * FROM transactions WHERE id = ?").get(info.lastInsertRowid);
    return json(ctx.res, 201, { transaction: row });
  }));

  // מחיקת תנועה (למשל טעות בהזנה)
  router.delete("/api/transactions/:id", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM transactions WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "תנועה לא נמצאה" });
    db.prepare("DELETE FROM transactions WHERE id = ?").run(row.id);
    return json(ctx.res, 200, { message: "התנועה נמחקה" });
  }));

  // מגמה חודשית פשוטה (12 חודשים אחרונים) — לגרף באזור האישי
  router.get("/api/transactions/trend", requireAuth(async (ctx) => {
    const rows = db
      .prepare(
        `SELECT strftime('%Y-%m', occurred_at) AS month,
                SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) AS income,
                SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expense
         FROM transactions WHERE user_id = ?
         GROUP BY month ORDER BY month DESC LIMIT 12`
      )
      .all(ctx.user.userId);
    return json(ctx.res, 200, { trend: rows.reverse() });
  }));
}

module.exports = { register };
