"use strict";
const db = require("../db");
const { json } = require("../router");
const { hashPassword, verifyPassword, signToken, generateOtpCode, hashCode } = require("../utils/crypto");
const { requireAuth } = require("../middleware/auth");
const { sendRecoveryCode } = require("../services/recoveryChannel");

// תפקידים אפשריים - מוצג כמחרוזת מופרדת בפסיקים בעמודת roles (למשל "mentor,therapist").
// "parent" (הורה) לא נכלל כאן בכוונה: שיוך הורה-ילד נקבע מבנית דרך טבלת student_guardians,
// לא דרך תפקיד חופשי, כדי שאי אפשר יהיה "להצהיר" על עצמך כהורה של תלמיד שלא שייך אליך.
const VALID_ROLES = ["private", "mentor", "therapist", "supervisor"];
function sanitizeRoles(rolesInput, fallback) {
  if (!rolesInput) return fallback;
  const list = String(rolesInput).split(",").map(r => r.trim()).filter(r => VALID_ROLES.includes(r));
  return list.length ? list.join(",") : fallback;
}

function register(router) {
  // ---------- הרשמה ----------
  router.post("/api/auth/signup", async (ctx) => {
    const { full_name, phone, email, username, password, roles } = ctx.body;
    if (!full_name || !username || !password) {
      return json(ctx.res, 400, { error: "יש למלא שם מלא, שם משתמש וסיסמה" });
    }
    const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (exists) return json(ctx.res, 409, { error: "שם המשתמש כבר תפוס" });

    const password_hash = hashPassword(password);
    const finalRoles = sanitizeRoles(roles, "private");
    const info = db
      .prepare("INSERT INTO users (full_name, username, password_hash, phone, email, roles) VALUES (?, ?, ?, ?, ?, ?)")
      .run(full_name, username, password_hash, phone || null, email || null, finalRoles);

    const token = signToken({ userId: info.lastInsertRowid, username });
    return json(ctx.res, 201, { token, user: publicUser(info.lastInsertRowid) });
  });

  // ---------- התחברות ----------
  router.post("/api/auth/login", async (ctx) => {
    const { username, password } = ctx.body;
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!user || !verifyPassword(password || "", user.password_hash)) {
      return json(ctx.res, 401, { error: "שם משתמש או סיסמה שגויים" });
    }
    const token = signToken({ userId: user.id, username: user.username });
    return json(ctx.res, 200, { token, user: publicUser(user.id) });
  });

  // ---------- שחזור סיסמה: שלב 1 - בקשת קוד ----------
  router.post("/api/auth/forgot-password/request", async (ctx) => {
    const { username, channel } = ctx.body; // channel: 'phone' | 'email'
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!user) return json(ctx.res, 404, { error: "משתמש לא נמצא" });

    const code = generateOtpCode();
    const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO password_resets (user_id, channel, code_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(user.id, channel === "email" ? "email" : "phone", hashCode(code), expires_at);

    // בייצור: שיחה קולית אוטומטית שמקריאה את הקוד (או מייל) - ר' services/recoveryChannel.js
    const deliveryResult = await sendRecoveryCode({ channel, phone: user.phone, email: user.email, code });
    return json(ctx.res, 200, {
      message: channel === "email" ? "קוד נשלח למייל הרשום" : "מתבצעת שיחה קולית עם הקוד",
      ...deliveryResult, // במצב MOCK כולל demoCode לבדיקה
    });
  });

  // ---------- שחזור סיסמה: שלב 2 - אימות קוד ----------
  router.post("/api/auth/forgot-password/verify", async (ctx) => {
    const { username, code } = ctx.body;
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!user) return json(ctx.res, 404, { error: "משתמש לא נמצא" });

    const reset = db
      .prepare("SELECT * FROM password_resets WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1")
      .get(user.id);
    if (!reset || reset.code_hash !== hashCode(code) || new Date(reset.expires_at) < new Date()) {
      return json(ctx.res, 400, { error: "קוד שגוי או שפג תוקפו" });
    }
    db.prepare("UPDATE password_resets SET used = 1 WHERE id = ?").run(reset.id);
    const resetToken = signToken({ userId: user.id, purpose: "password_reset" }, 60 * 10);
    return json(ctx.res, 200, { resetToken });
  });

  // ---------- שחזור סיסמה: שלב 3 - קביעת סיסמה חדשה ----------
  router.post("/api/auth/forgot-password/reset", async (ctx) => {
    const { resetToken, newPassword } = ctx.body;
    const { verifyToken } = require("../utils/crypto");
    const payload = verifyToken(resetToken);
    if (!payload || payload.purpose !== "password_reset") {
      return json(ctx.res, 400, { error: "טוקן שחזור לא תקין או שפג תוקפו" });
    }
    if (!newPassword || newPassword.length < 4) return json(ctx.res, 400, { error: "סיסמה קצרה מדי" });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), payload.userId);
    return json(ctx.res, 200, { message: "הסיסמה עודכנה בהצלחה" });
  });

  // ---------- פרופיל אישי ----------
  router.get("/api/me", requireAuth(async (ctx) => {
    return json(ctx.res, 200, { user: publicUser(ctx.user.userId) });
  }));

  router.put("/api/me", requireAuth(async (ctx) => {
    const { full_name, phone, phone2, email, default_session_minutes, budget_alerts, roles } = ctx.body;
    // הערה חשובה: node:sqlite (בניגוד לספריות כמו better-sqlite3) לא מקבל את הערך
    // undefined כפרמטר מחייב (bind parameter) וזורק שגיאה - חובה להמיר שדות חסרים ל-null.
    // roles: מאפשר למשתמש להצהיר על עצמו כחונך/מטפל/מפקח (private,mentor,therapist,supervisor).
    // חשוב: "parent" לא ניתן להוספה כאן בכוונה - שיוך הורה-ילד נעשה רק דרך student_guardians.
    const currentUser = db.prepare("SELECT roles FROM users WHERE id = ?").get(ctx.user.userId);
    const sanitizedRoles = roles !== undefined ? sanitizeRoles(roles, currentUser.roles) : null;
    db.prepare(
      `UPDATE users SET full_name = COALESCE(?, full_name), phone = COALESCE(?, phone),
       phone2 = COALESCE(?, phone2), email = COALESCE(?, email),
       default_session_minutes = COALESCE(?, default_session_minutes),
       budget_alerts = COALESCE(?, budget_alerts),
       roles = COALESCE(?, roles) WHERE id = ?`
    ).run(
      full_name ?? null,
      phone ?? null,
      phone2 ?? null,
      email ?? null,
      default_session_minutes ?? null,
      budget_alerts ?? null,
      sanitizedRoles,
      ctx.user.userId
    );
    return json(ctx.res, 200, { user: publicUser(ctx.user.userId) });
  }));

  router.put("/api/me/password", requireAuth(async (ctx) => {
    const { currentPassword, newPassword } = ctx.body;
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(ctx.user.userId);
    if (!verifyPassword(currentPassword || "", user.password_hash)) {
      return json(ctx.res, 400, { error: "הסיסמה הנוכחית שגויה" });
    }
    if (!newPassword || newPassword.length < 4) return json(ctx.res, 400, { error: "סיסמה חדשה קצרה מדי" });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), user.id);
    return json(ctx.res, 200, { message: "הסיסמה עודכנה בהצלחה" });
  }));
}

function publicUser(userId) {
  const u = db.prepare("SELECT id, full_name, username, phone, phone2, email, roles, default_session_minutes, budget_alerts FROM users WHERE id = ?").get(userId);
  return u;
}

module.exports = { register, publicUser };
