// systemAdmin.js — "מנהל מערכת": כפתור ניהול-על מוגן בסיסמה מיוחדת (לא קשור לחשבון משתמש/התחברות
// רגילה), שמאפשר להוסיף/להסיר ישירות את תפקיד "מפקח" למשתמש כלשהו במערכת - בלי לעבור את תהליך
// הקוד הדו-שלבי מול "בעל הקו" (ר' auth.js, /api/me/request-supervisor + confirm-supervisor).
//
// למה זה קיים בנוסף לתהליך הקיים (בקשה מ"בעל הקו" + קוד למייל): המשוב מהמשתמש היה שהתהליך הקיים
// מרגיש עקיף מדי כשיש רק "בעל קו" יחיד שגם מנהל בפועל את כל המערכת - הוא רוצה כפתור פשוט שמאפשר לו
// להפוך מישהו למפקח ישירות, בלי שהמשתמש השני יצטרך ליזום בקשה ולעבור שלב אימות. **חשוב**: זה לא
// מחליף את התהליך הקיים (עדיין קיים ועובד בדיוק כמו קודם) - זו רק דרך נוספת ומהירה יותר.
//
// אבטחה: כל הנתיבים כאן דורשים סיסמה מיוחדת (SYSTEM_ADMIN_PASSWORD, ר' .env.example) שמושווית בזמן-
// קבוע (crypto.timingSafeEqual) כדי לצמצם חשיפה להתקפת תזמון. **כל עוד המשתנה הזה לא מוגדר, התכונה
// כבויה לגמרי** (בדיוק כמו שאר התכונות האופציונליות במערכת - Whisper/Twilio/Cardcom וכו') - אין שום
// דרך לגשת לנתיבים האלה בלי שהוגדרה סיסמה בפירוש ב-Render. הנתיבים האלה **לא** משתמשים ב-requireAuth
// הרגיל (JWT) - הם שער נפרד ומכוון, בדיוק כמו שהמשתמש ביקש ("כפתור מנהל מערכת עם סיסמה מיוחדת").
"use strict";
const crypto = require("crypto");
const db = require("../db");
const { json } = require("../router");

// השוואת סיסמה בזמן-קבוע - נכשל (false) גם אם האורך שונה, בלי לחשוף מידע על האורך הנכון דרך תזמון.
function passwordMatches(candidate) {
  const expected = process.env.SYSTEM_ADMIN_PASSWORD;
  if (!expected || typeof candidate !== "string" || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function publicUserRow(u) {
  return { id: u.id, full_name: u.full_name, username: u.username, phone: u.phone, email: u.email, roles: u.roles };
}

function register(router) {
  // חיפוש משתמשים לפי שם/שם משתמש/טלפון (חלקי, לא רגיש לרישיות) - כדי למצוא את מי שרוצים להפוך למפקח.
  router.post("/api/system-admin/search-users", async (ctx) => {
    const { password, query } = ctx.body || {};
    if (!process.env.SYSTEM_ADMIN_PASSWORD) {
      return json(ctx.res, 503, { error: "תכונת 'מנהל מערכת' לא מוגדרת בשרת הזה (חסר SYSTEM_ADMIN_PASSWORD)" });
    }
    if (!passwordMatches(password)) return json(ctx.res, 403, { error: "סיסמת מנהל המערכת שגויה" });

    const q = String(query || "").trim();
    if (!q) return json(ctx.res, 400, { error: "יש להזין מילת חיפוש (שם, שם משתמש, או טלפון)" });

    const like = `%${q}%`;
    const rows = db
      .prepare(
        `SELECT id, full_name, username, phone, phone2, email, roles FROM users
         WHERE full_name LIKE ? OR username LIKE ? OR phone LIKE ? OR phone2 LIKE ?
         ORDER BY full_name LIMIT 20`
      )
      .all(like, like, like, like);
    return json(ctx.res, 200, { users: rows.map(publicUserRow) });
  });

  // הוספת תפקיד "מפקח" ישירות - בלי תהליך הקוד מול בעל הקו.
  router.post("/api/system-admin/grant-supervisor", async (ctx) => {
    const { password, user_id } = ctx.body || {};
    if (!process.env.SYSTEM_ADMIN_PASSWORD) {
      return json(ctx.res, 503, { error: "תכונת 'מנהל מערכת' לא מוגדרת בשרת הזה (חסר SYSTEM_ADMIN_PASSWORD)" });
    }
    if (!passwordMatches(password)) return json(ctx.res, 403, { error: "סיסמת מנהל המערכת שגויה" });

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(user_id));
    if (!user) return json(ctx.res, 404, { error: "משתמש לא נמצא" });

    const roles = (user.roles || "").split(",").map(r => r.trim()).filter(Boolean);
    if (!roles.includes("supervisor")) roles.push("supervisor");
    db.prepare("UPDATE users SET roles = ? WHERE id = ?").run(roles.join(","), user.id);

    const updated = db.prepare("SELECT id, full_name, username, phone, email, roles FROM users WHERE id = ?").get(user.id);
    return json(ctx.res, 200, { message: `${user.full_name} הוגדר/ה כמפקח/ת בהצלחה`, user: updated });
  });

  // הסרת תפקיד "מפקח" - לתיקון טעות הענקה, בלי צורך לגעת בשאר התפקידים של המשתמש.
  router.post("/api/system-admin/revoke-supervisor", async (ctx) => {
    const { password, user_id } = ctx.body || {};
    if (!process.env.SYSTEM_ADMIN_PASSWORD) {
      return json(ctx.res, 503, { error: "תכונת 'מנהל מערכת' לא מוגדרת בשרת הזה (חסר SYSTEM_ADMIN_PASSWORD)" });
    }
    if (!passwordMatches(password)) return json(ctx.res, 403, { error: "סיסמת מנהל המערכת שגויה" });

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(user_id));
    if (!user) return json(ctx.res, 404, { error: "משתמש לא נמצא" });

    const roles = (user.roles || "").split(",").map(r => r.trim()).filter(r => r && r !== "supervisor");
    db.prepare("UPDATE users SET roles = ? WHERE id = ?").run(roles.join(","), user.id);

    const updated = db.prepare("SELECT id, full_name, username, phone, email, roles FROM users WHERE id = ?").get(user.id);
    return json(ctx.res, 200, { message: `הרשאת המפקח/ת של ${user.full_name} הוסרה`, user: updated });
  });
}

module.exports = { register, passwordMatches };
