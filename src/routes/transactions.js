// transactions.js — ניהול תקציב אישי: הכנסות/הוצאות, יתרה, פילוח לפי קטגוריה.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");
const { rememberPhrase, getDictionary } = require("../lib/dictionary");

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

    // קטגוריה שהוזנה (מהאתר או מהטלפון - ר' routes/ivr.js case "expense_confirm"/"income_confirm")
    // נכנסת גם ל"מילון" הניסוחים האישי, בדיוק כמו note/trend/role_type בדוחות טיפוליים - כדי שקטגוריות
    // מותאמות-אישית (למשל "תרופות" בהוצאה, או "חונכות" בהכנסה) יוצעו אוטומטית בפעם הבאה, גם אם
    // הוכתבו בטלפון. תוקן (משוב אמיתי: "כשאני לוחץ על הכנסה אין קטגוריה אם זה ביטוח לאומי או משכורת
    // או חונכות") - בעבר זה נשמר רק להוצאות (kind=expense_category); הכנסות עם קטגוריה מותאמת-אישית
    // נעלמו בשקט בכל פעם, ולא הוצעו יותר לא באתר ולא בטלפון.
    if (category) rememberPhrase(ctx.user.userId, type === "income" ? "income_category" : "expense_category", category);

    const row = db.prepare("SELECT * FROM transactions WHERE id = ?").get(info.lastInsertRowid);
    return json(ctx.res, 201, { transaction: row });
  }));

  // "מילון" קטגוריות אישי של המשתמש המחובר - להצעת השלמה אוטומטית (באתר: datalist, ר' public/app.html;
  // בטלפון: לא מוצג בקול, אבל אותה רשימה בדיוק נבנית ומוזנת גם משם). ?type=income מחזיר את מילון
  // ההכנסות (kind=income_category) - ברירת המחדל (גם עם type לא-מוכר) נשארת expense_category, לתאימות
  // לאחור עם קריאות קיימות שלא שלחו type בכלל.
  router.get("/api/transactions/dictionary", requireAuth(async (ctx) => {
    const kind = ctx.query.type === "income" ? "income_category" : "expense_category";
    return json(ctx.res, 200, { phrases: getDictionary(ctx.user.userId, kind) });
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
