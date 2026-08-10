// subscription.js — תוכניות "תרומה חודשית", הרשמה לתוכנית (מול Cardcom), ומסך ניהול תמחור למנהל.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");
const { createRecurringCharge } = require("../services/cardcom");

function isAdmin(user) {
  const row = db.prepare("SELECT roles FROM users WHERE id = ?").get(user.userId);
  return !!row && (row.roles || "").split(",").includes("admin");
}

function register(router) {
  // רשימת תוכניות (ציבורי — נדרש למסך "פתחו חשבון" לפני התחברות)
  router.get("/api/plans", async (ctx) => {
    const rows = db.prepare("SELECT * FROM plans ORDER BY price ASC").all();
    return json(ctx.res, 200, { plans: rows.map(parsePlan) });
  });

  // עדכון תמחור תוכנית — למנהל בלבד
  router.put("/api/plans/:id", requireAuth(async (ctx) => {
    if (!isAdmin(ctx.user)) return json(ctx.res, 403, { error: "פעולה זו זמינה למנהל המערכת בלבד" });
    const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(ctx.params.id);
    if (!plan) return json(ctx.res, 404, { error: "תוכנית לא נמצאה" });

    const { name, price, features } = ctx.body;
    db.prepare("UPDATE plans SET name = COALESCE(?, name), price = COALESCE(?, price), features = COALESCE(?, features) WHERE id = ?")
      .run(name || null, price != null ? Number(price) : null, features ? JSON.stringify(features) : null, plan.id);

    return json(ctx.res, 200, { plan: parsePlan(db.prepare("SELECT * FROM plans WHERE id = ?").get(plan.id)) });
  }));

  // מנוי נוכחי של המשתמש המחובר
  router.get("/api/subscription/me", requireAuth(async (ctx) => {
    const sub = db
      .prepare(
        `SELECT sub.*, p.name AS plan_name, p.price AS plan_price FROM subscriptions sub
         JOIN plans p ON p.id = sub.plan_id
         WHERE sub.user_id = ? ORDER BY sub.id DESC LIMIT 1`
      )
      .get(ctx.user.userId);
    return json(ctx.res, 200, { subscription: sub || null });
  }));

  // הצטרפות/מעבר לתוכנית תרומה (יוצר הוראת קבע מול Cardcom)
  router.post("/api/subscribe", requireAuth(async (ctx) => {
    const { planId } = ctx.body;
    const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
    if (!plan) return json(ctx.res, 404, { error: "תוכנית לא נמצאה" });

    const user = db.prepare("SELECT full_name, email FROM users WHERE id = ?").get(ctx.user.userId);
    const charge = await createRecurringCharge({
      userId: ctx.user.userId,
      planId: plan.id,
      amount: plan.price,
      fullName: user.full_name,
      email: user.email,
    });

    const nextBilling = new Date();
    nextBilling.setMonth(nextBilling.getMonth() + 1);

    const info = db
      .prepare(
        `INSERT INTO subscriptions (user_id, plan_id, status, next_billing_date, cardcom_recurring_id)
         VALUES (?, ?, 'active', ?, ?)`
      )
      .run(ctx.user.userId, plan.id, nextBilling.toISOString(), charge.cardcom_recurring_id || null);

    return json(ctx.res, 201, {
      message: `הצטרפת בהצלחה לתוכנית "${plan.name}" (₪${plan.price} לחודש)`,
      mock: !!charge.mock,
      paymentUrl: charge.paymentUrl || null,
      subscription: db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(info.lastInsertRowid),
    });
  }));
}

function parsePlan(row) {
  return { ...row, features: JSON.parse(row.features) };
}

module.exports = { register };
