// crypto.js — הצפנת סיסמאות (scrypt) וטוקני התחברות (JWT מינימלי בעצמנו).
// הכל מבוסס על מודול ה-crypto המובנה של Node.js — אין צורך ב-bcrypt/jsonwebtoken חיצוניים.
"use strict";

const crypto = require("crypto");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me-in-production";

// ---------- סיסמאות (scrypt + salt, שקול ל-bcrypt מבחינת אבטחה) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

// ---------- JWT מינימלי (HS256) ----------
function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(input) {
  input = input.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4) input += "=";
  return Buffer.from(input, "base64").toString();
}

function signToken(payload, expiresInSeconds = 60 * 60 * 24 * 30) {
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const headerPart = base64url(JSON.stringify(header));
  const payloadPart = base64url(JSON.stringify(fullPayload));
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(`${headerPart}.${payloadPart}`).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${headerPart}.${payloadPart}.${signature}`;
}

function verifyToken(token) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signature] = parts;
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${headerPart}.${payloadPart}`).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (signature !== expected) return null;
  try {
    const payload = JSON.parse(base64urlDecode(payloadPart));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null; // פג תוקף
    return payload;
  } catch {
    return null;
  }
}

// ---------- קוד חד-פעמי לשחזור סיסמה (4 ספרות) ----------
function generateOtpCode() {
  return String(crypto.randomInt(1000, 9999));
}
function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, generateOtpCode, hashCode };
