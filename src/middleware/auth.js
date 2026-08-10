"use strict";
const { verifyToken } = require("../utils/crypto");

// מחזיר את המשתמש המחובר מתוך כותרת Authorization: Bearer <token>, או null אם אין/לא תקין
function getAuthUser(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  return verifyToken(token); // { userId, username, iat, exp } | null
}

// עוטף handler ומחייב התחברות; מזריק ctx.user
function requireAuth(handler) {
  return async (ctx) => {
    const user = getAuthUser(ctx.req);
    if (!user) {
      const { json } = require("../router");
      return json(ctx.res, 401, { error: "נדרשת התחברות" });
    }
    ctx.user = user;
    return handler(ctx);
  };
}

module.exports = { getAuthUser, requireAuth };
