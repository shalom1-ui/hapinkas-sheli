"use strict";
const db = require("../db");
const { json } = require("../router");
const { hashPassword, verifyPassword, signToken, generateOtpCode, hashCode, isValidPin } = require("../utils/crypto");
const { requireAuth } = require("../middleware/auth");
const { sendRecoveryCode } = require("../services/recoveryChannel");

// תפקידים אפשריים - מוצג כמחרוזת מופרדת בפסיקים בעמודת roles (למשל "mentor,therapist").
// "parent" (הורה) לא נכלל כאן בכוונה: שיוך הורה-ילד נקבע מבנית דרך טבלת student_guardians,
// לא דרך תפקיד חופשי, כדי שאי אפשר יהיה "להצהיר" על עצמך כהורה של תלמיד שלא שייך אליך.
// "admin" גם לא נכלל בכוונה - הוא לא ניתן להצהרה עצמית בכלל (ר' המיגרציה ב-db.js).
const VALID_ROLES = ["private", "mentor", "therapist", "supervisor"];
// "supervisor" הוצא בכוונה מהתפקידים שניתן להצהיר עליהם ישירות דרך הרשמה/עדכון פרופיל - זה תפקיד
// עם גישה רגישה (לצ'אט הפנימי ולדוחות של כל תלמיד, לא רק תלמידים שרשמת בעצמך), ולכן הוא ניתן רק
// דרך תהליך אישור ייעודי מול "בעל הקו" (ר' /api/me/request-supervisor למטה) - לא דרך השדה roles הכללי.
const SELF_DECLARABLE_ROLES = VALID_ROLES.filter(r => r !== "supervisor");
// תפקידים שלעולם לא ניתנים דרך /api/me הכללי - רק דרך admin ידני (admin) או תהליך אישור ייעודי (supervisor)
const PRIVILEGED_ROLES = ["admin", "supervisor"];
function sanitizeRoles(rolesInput, fallback) {
  if (!rolesInput) return fallback;
  const list = String(rolesInput).split(",").map(r => r.trim()).filter(r => SELF_DECLARABLE_ROLES.includes(r));
  return list.length ? list.join(",") : fallback;
}

// מחשבים מזהה כניסה: שם משתמש, **או** מספר טלפון רשום (כולל שני הפורמטים הנפוצים - מקומי כמו
// "0501234567" ובינלאומי כמו "+972501234567", בדיוק כמו findUserByPhone/phoneCandidates ב-
// routes/yemot.js). למה זה חשוב: מי שנרשם ישירות בטלפון (ר' routes/ivr.js, createPhoneUser) מקבל
// שם משתמש אוטומטי (`phone_XXXXXXXXX`) שהוא **לעולם לא נאמר לו בקול** - הזיהוי בטלפון עצמו הוא
// תמיד לפי Caller ID, לא לפי שם משתמש. בלי האפשרות להתחבר גם עם מספר הטלפון עצמו, למי שנרשם
// כך אין שום דרך סבירה לדעת מה להקליד בשדה "שם משתמש" באתר - הוא פשוט יקבל "סיסמה שגויה" גם עם
// ה-PIN הנכון (כי בפועל שם המשתמש הוא השגוי, לא הסיסמה - אבל הודעת השגיאה לא מבדילה בין השניים).
function findUserByLoginIdentifier(identifier) {
  const byUsername = db.prepare("SELECT * FROM users WHERE username = ?").get(identifier);
  if (byUsername) return byUsername;
  const digits = String(identifier || "").replace(/\D/g, "");
  if (!digits) return null;
  const local = digits.startsWith("972") ? "0" + digits.slice(3) : digits; // 972501234567 -> 0501234567
  const noLeadingZero = local.replace(/^0/, "");
  const candidates = Array.from(new Set([identifier, digits, local, `+972${noLeadingZero}`, `972${noLeadingZero}`])).filter(Boolean);
  for (const candidate of candidates) {
    const user = db.prepare("SELECT * FROM users WHERE phone = ? OR phone2 = ?").get(candidate, candidate);
    if (user) return user;
  }
  return null;
}

function register(router) {
  // ---------- הרשמה ----------
  router.post("/api/auth/signup", async (ctx) => {
    const { full_name, phone, email, username, password, roles } = ctx.body;
    if (!full_name || !username || !password) {
      return json(ctx.res, 400, { error: "יש למלא שם מלא, שם משתמש וסיסמה" });
    }
    // הסיסמה חייבת להיות בדיוק קוד בן 4 ספרות (ר' utils/crypto.js / isValidPin) - כדי שאותה סיסמה
    // בדיוק תעבוד גם כקוד PIN בטלפון (ר' routes/ivr.js, signup_pin), ולהפך: קוד PIN שהוגדר בטלפון
    // יעבוד גם להתחברות כאן. משתמשים קיימים עם סיסמה ישנה לא נפגעים - האכיפה חלה רק על סיסמה חדשה.
    if (!isValidPin(password)) {
      return json(ctx.res, 400, { error: "הסיסמה חייבת להיות בדיוק קוד בן 4 ספרות (למשל 1234) - כדי שאותה סיסמה תעבוד גם כקוד PIN בטלפון" });
    }
    const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (exists) return json(ctx.res, 409, { error: "שם המשתמש כבר תפוס" });

    const password_hash = hashPassword(password);
    const finalRoles = sanitizeRoles(roles, "private");
    // signup_channel נשאר בברירת המחדל 'web' (ר' db.js) - הרשמה כאן היא תמיד דרך האתר עצמו,
    // עם סיסמה שהמשתמש בחר בעצמו (בניגוד לחשבון שנוצר אוטומטית מהטלפון, ר' routes/ivr.js).
    const info = db
      .prepare("INSERT INTO users (full_name, username, password_hash, phone, email, roles) VALUES (?, ?, ?, ?, ?, ?)")
      .run(full_name, username, password_hash, phone || null, email || null, finalRoles);

    const token = signToken({ userId: info.lastInsertRowid, username });
    return json(ctx.res, 201, { token, user: publicUser(info.lastInsertRowid) });
  });

  // ---------- התחברות ----------
  router.post("/api/auth/login", async (ctx) => {
    const { username, password } = ctx.body;
    // מתקבל גם מספר טלפון רשום כתחליף לשם משתמש (ר' findUserByLoginIdentifier למעלה) - חשוב במיוחד
    // למי שנרשם דרך הטלפון וקיבל שם משתמש אוטומטי שאף פעם לא נאמר לו בקול.
    const user = findUserByLoginIdentifier(username);
    if (!user || !verifyPassword(password || "", user.password_hash)) {
      return json(ctx.res, 401, { error: "שם משתמש או סיסמה שגויים" });
    }
    const token = signToken({ userId: user.id, username: user.username });
    return json(ctx.res, 200, { token, user: publicUser(user.id) });
  });

  // ---------- שחזור סיסמה: שלב 1 - בקשת קוד ----------
  router.post("/api/auth/forgot-password/request", async (ctx) => {
    const { username, channel } = ctx.body; // channel: 'phone' | 'email'
    // גם כאן מתקבל מספר טלפון רשום כתחליף לשם משתמש (ר' findUserByLoginIdentifier) - מי שנרשם
    // בטלפון ולא זוכר/לא יודע את שם המשתמש האוטומטי שלו עדיין צריך דרך לשחזר גישה.
    const user = findUserByLoginIdentifier(username);
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
    const user = findUserByLoginIdentifier(username); // ר' הערה למעלה - מתקבל גם מספר טלפון
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
    if (!isValidPin(newPassword)) {
      return json(ctx.res, 400, { error: "הסיסמה חייבת להיות בדיוק קוד בן 4 ספרות (למשל 1234) - כדי שאותה סיסמה תעבוד גם כקוד PIN בטלפון" });
    }
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
    // roles: מאפשר למשתמש להצהיר על עצמו כחונך/מטפל (private,mentor,therapist) - לא על "מפקח"/"admin"
    // (ר' SELF_DECLARABLE_ROLES/PRIVILEGED_ROLES למעלה). חשוב: "parent" לא ניתן להוספה כאן בכוונה -
    // שיוך הורה-ילד נעשה רק דרך student_guardians.
    const currentUser = db.prepare("SELECT roles FROM users WHERE id = ?").get(ctx.user.userId);
    let sanitizedRoles = null;
    if (roles !== undefined) {
      const selfDeclared = sanitizeRoles(roles, currentUser.roles).split(",").map(r => r.trim()).filter(Boolean);
      // תפקידים רגישים (admin/supervisor) לעולם לא ניתנים להוספה/הסרה דרך המסלול הכללי הזה - רק
      // נשמרים כמו שהם, כדי שמשתמש שכבר קיבל אותם דרך תהליך אישור ייעודי לא "יאבד" אותם בטעות
      // כי המסך הכללי לא הציג/שלח אותם.
      const currentPrivileged = (currentUser.roles || "").split(",").map(r => r.trim()).filter(r => PRIVILEGED_ROLES.includes(r));
      sanitizedRoles = Array.from(new Set([...selfDeclared, ...currentPrivileged])).join(",");
    }
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
    if (!isValidPin(newPassword)) {
      return json(ctx.res, 400, { error: "הסיסמה החדשה חייבת להיות בדיוק קוד בן 4 ספרות (למשל 1234) - כדי שאותה סיסמה תעבוד גם כקוד PIN בטלפון" });
    }
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), user.id);
    return json(ctx.res, 200, { message: "הסיסמה עודכנה בהצלחה" });
  }));

  // ---------- הפיכה ל"מפקח" - דורש אישור בעל הקו (admin), לא הצהרה עצמית ----------
  // שלב 1: מזינים את מספר הטלפון של בעל הקו. אם הוא נכון - נשלח קוד בן 4 ספרות למייל הרשום שלו
  // (בעל הקו מעביר את הקוד בעל פה/בטלפון למי שביקש). תשובת ה-API זהה בין "מספר נכון" ל"מספר שגוי" -
  // כדי לא לאפשר לנחש/לסרוק מי בעל הקו.
  router.post("/api/me/request-supervisor", requireAuth(async (ctx) => {
    const { admin_phone } = ctx.body;
    if (!admin_phone) return json(ctx.res, 400, { error: "יש להזין את מספר הטלפון של בעל הקו" });

    const generic = { message: "אם זה מספר הטלפון של בעל הקו, קוד אישור בן 4 ספרות נשלח כעת למייל הרשום שלו. בקשו ממנו את הקוד כדי להשלים." };
    const candidates = db.prepare("SELECT * FROM users WHERE phone = ? OR phone2 = ?").all(admin_phone, admin_phone);
    const admin = candidates.find(u => (u.roles || "").split(",").map(r => r.trim()).includes("admin"));
    if (!admin || !admin.email) return json(ctx.res, 200, generic);

    const code = generateOtpCode();
    const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO role_upgrade_requests (user_id, code_hash, expires_at) VALUES (?, ?, ?)")
      .run(ctx.user.userId, hashCode(code), expires_at);

    // הערה: sendRecoveryCode במצב MOCK (ברירת מחדל בפיתוח/בדיקות) מחזירה גם demoCode בתשובה, כדי
    // שאפשר יהיה לבדוק את הזרימה בלי ספק מייל אמיתי - בייצור אמיתי (RECOVERY_MOCK=false) זה לא
    // קורה, והקוד מגיע רק בפועל למייל של בעל הקו, בדיוק כמו שצריך שיהיה.
    const deliveryResult = await sendRecoveryCode({ channel: "email", email: admin.email, code });
    return json(ctx.res, 200, { ...generic, ...deliveryResult });
  }));

  // שלב 2: מי שביקש מזין את הקוד שקיבל מבעל הקו (בעל פה) - אם תואם, מתווסף roles=supervisor בפועל.
  router.post("/api/me/confirm-supervisor", requireAuth(async (ctx) => {
    const { code } = ctx.body;
    if (!code) return json(ctx.res, 400, { error: "יש להזין את הקוד שקיבלתם מבעל הקו" });

    const pending = db
      .prepare("SELECT * FROM role_upgrade_requests WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1")
      .get(ctx.user.userId);
    if (!pending || pending.code_hash !== hashCode(code) || new Date(pending.expires_at) < new Date()) {
      return json(ctx.res, 400, { error: "קוד שגוי או שפג תוקפו - אפשר לבקש קוד חדש" });
    }
    db.prepare("UPDATE role_upgrade_requests SET used = 1 WHERE id = ?").run(pending.id);

    const currentUser = db.prepare("SELECT roles FROM users WHERE id = ?").get(ctx.user.userId);
    const roles = (currentUser.roles || "").split(",").map(r => r.trim()).filter(Boolean);
    if (!roles.includes("supervisor")) roles.push("supervisor");
    db.prepare("UPDATE users SET roles = ? WHERE id = ?").run(roles.join(","), ctx.user.userId);

    return json(ctx.res, 200, { message: "אושרתם כמפקח/ת בהצלחה!", user: publicUser(ctx.user.userId) });
  }));

  // ---------- תביעת "בעל הקו" (admin) - לא "המשתמש הראשון שנרשם", אלא מי שנרשם באתר עצמו ----------
  // (signup_channel='web', כלומר בחר בעצמו סיסמה - לא חשבון אוטומטי מהטלפון) ומאמת בפועל בעלות על
  // הטלפון הרשום שלו, דרך קוד ב"שיחה קולית" (אותו מנגנון בדיוק כמו שחזור סיסמה). אין "קוד סודי" נסתר
  // בשום מקום - מי שממלא את שני התנאים האלה יכול לתבוע את התפקיד, וזה נחסם ברגע שכבר יש בעל קו.
  router.get("/api/me/admin-claim-status", requireAuth(async (ctx) => {
    const me = db.prepare("SELECT roles, signup_channel, phone FROM users WHERE id = ?").get(ctx.user.userId);
    const adminExists = db.prepare("SELECT COUNT(*) AS c FROM users WHERE roles LIKE '%admin%'").get().c > 0;
    const isAdmin = (me.roles || "").split(",").map(r => r.trim()).includes("admin");
    return json(ctx.res, 200, {
      isAdmin,
      adminExists,
      eligible: !isAdmin && !adminExists && me.signup_channel === "web" && !!me.phone,
    });
  }));

  router.post("/api/me/request-admin-claim", requireAuth(async (ctx) => {
    const adminExists = db.prepare("SELECT COUNT(*) AS c FROM users WHERE roles LIKE '%admin%'").get().c > 0;
    if (adminExists) return json(ctx.res, 409, { error: "כבר קיים בעל קו רשום במערכת" });

    const me = db.prepare("SELECT * FROM users WHERE id = ?").get(ctx.user.userId);
    if (me.signup_channel !== "web") {
      return json(ctx.res, 403, { error: "רק חשבון שנרשם באתר עצמו (עם סיסמה שנבחרה, לא חשבון שנוצר אוטומטית מהטלפון) יכול לתבוע את תפקיד בעל הקו" });
    }
    if (!me.phone) return json(ctx.res, 400, { error: "יש להזין מספר טלפון בפרופיל שלכם לפני תביעת בעל הקו - הוא הערוץ לאימות" });

    const code = generateOtpCode();
    const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO admin_claim_requests (user_id, code_hash, expires_at) VALUES (?, ?, ?)")
      .run(ctx.user.userId, hashCode(code), expires_at);

    // כאן זה אימות עצמי (מוודאים שהמבקש באמת מחזיק בטלפון הרשום שלו) - לא כמו אישור מפקח שדורש
    // סודיות בין שני אנשים - ולכן demoCode במצב MOCK תמיד בטוח להחזיר גם כאן.
    const deliveryResult = await sendRecoveryCode({ channel: "phone", phone: me.phone, code });
    return json(ctx.res, 200, {
      message: "קוד אישור בן 4 ספרות נשלח בשיחה קולית למספר הטלפון הרשום שלכם.",
      ...deliveryResult,
    });
  }));

  router.post("/api/me/confirm-admin-claim", requireAuth(async (ctx) => {
    const { code } = ctx.body;
    if (!code) return json(ctx.res, 400, { error: "יש להזין את הקוד שהתקבל בשיחה הקולית" });

    const adminExists = db.prepare("SELECT COUNT(*) AS c FROM users WHERE roles LIKE '%admin%'").get().c > 0;
    if (adminExists) return json(ctx.res, 409, { error: "כבר קיים בעל קו רשום במערכת" });

    const pending = db
      .prepare("SELECT * FROM admin_claim_requests WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1")
      .get(ctx.user.userId);
    if (!pending || pending.code_hash !== hashCode(code) || new Date(pending.expires_at) < new Date()) {
      return json(ctx.res, 400, { error: "קוד שגוי או שפג תוקפו - אפשר לבקש קוד חדש" });
    }
    db.prepare("UPDATE admin_claim_requests SET used = 1 WHERE id = ?").run(pending.id);

    const currentUser = db.prepare("SELECT roles FROM users WHERE id = ?").get(ctx.user.userId);
    const roles = (currentUser.roles || "").split(",").map(r => r.trim()).filter(Boolean);
    if (!roles.includes("admin")) roles.push("admin");
    db.prepare("UPDATE users SET roles = ? WHERE id = ?").run(roles.join(","), ctx.user.userId);

    return json(ctx.res, 200, { message: "אושרתם כבעל/ת הקו של המערכת!", user: publicUser(ctx.user.userId) });
  }));
}

function publicUser(userId) {
  const u = db.prepare("SELECT id, full_name, username, phone, phone2, email, roles, default_session_minutes, budget_alerts FROM users WHERE id = ?").get(userId);
  return u;
}

module.exports = { register, publicUser };
