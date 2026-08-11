// yemot.js (routes) — Webhook עבור קו "ימות המשיח" (שלוחת API, ext.ini: type=api).
// זהו אותו מנוע שיחה בדיוק כמו routes/ivr.js (Twilio) - שם מכונות המצבים advance()/advanceSignup()
// מיובאות משם - רק שכבת התרגום לפרוטוקול שונה: כאן עונים במחרוזות הפרוטוקול של ימות
// (services/yemot.js) במקום TwiML.
//
// זרימה טיפוסית מול ימות המשיח:
//   1) שיחה נכנסת -> ימות שולח POST עם ApiCallId (קבוע לאורך כל השיחה) ו-ApiPhone (מספר המתקשר)
//   2) מזהים משתמש לפי מספר טלפון: אם ידוע - שואלים לאיזו קטגוריה להיכנס; אם לא - מציעים הרשמה
//      ישירות בטלפון (advanceSignup, בדיוק כמו ב-Twilio)
//   3) ימות שולח POST נוסף עם אותו ApiCallId + השדה "speech" (מה שהמתקשר אמר, מזוהה ע"י ימות)
//   4) טוענים את מצב השיחה השמור (call_logs, לפי call_sid=ApiCallId), מתקדמים במכונת המצבים, עונים הלאה
//   5) חוזר חלילה עד לתשובת "id_list_message=...hangup" שמנתקת את השיחה
"use strict";

const db = require("../db");
const { text } = require("../router");
const { advance, advanceSignup, upsertCall, appendTranscript, MAIN_MENU_HINTS, mainMenuPrompt } = require("./ivr");
const { sayAndReadStt, sayAndHangup, VAL_NAME } = require("../services/yemot");

function register(router) {
  router.post("/api/ivr/yemot", async (ctx) => {
    const v = ctx.body || {};
    const callId = v.ApiCallId;

    // בקשה שלא מגיעה מימות (בדיקה ידנית בדפדפן וכו') - לא מחזירים שגיאה קשה, רק הודעה ברורה
    if (!callId) {
      return text(ctx.res, 200, "בקשה זו אינה בקשת ימות המשיח תקינה (חסר ApiCallId)");
    }

    // המתקשר ניתק - אין מה להשיב
    if (v.hangup === "yes") {
      return text(ctx.res, 200, "");
    }

    let call = db.prepare("SELECT * FROM call_logs WHERE call_sid = ?").get(callId);

    // ---------- תחילת שיחה חדשה: מזהים משתמש לפי מספר טלפון ----------
    if (!call) {
      const user = findUserByPhone(v.ApiPhone);
      if (!user) {
        upsertCall(callId, null, "signup_name", { phone: v.ApiPhone });
        return text(
          ctx.res,
          200,
          sayAndReadStt("מספר הטלפון שלך אינו מזוהה במערכת. אפשר להירשם עכשיו ישירות בטלפון, בלי לגשת לאתר. מה השם המלא שלכם?")
        );
      }

      upsertCall(callId, user.id, "main_menu", {});
      return text(ctx.res, 200, sayAndReadStt(mainMenuPrompt(user.full_name, { digitConfirm: true })));
    }

    // ---------- המשך שיחה קיימת ----------
    const speech = String(v[VAL_NAME] || "").trim();
    appendTranscript(callId, speech);
    const draft = JSON.parse(call.draft_json || "{}");

    // digitConfirm: true - בימות אפשר להקיש (כולל סולמית) תוך כדי זיהוי דיבור בלי לחסום את זה
    // (ר' services/yemot.js / sayAndReadStt), אז מוסיפים אפשרות אישור מהירה בהקשה בכל שאלת "אמרו כן לאישור".
    const result = call.user_id
      ? await advance(call.state, speech, draft, db.prepare("SELECT * FROM users WHERE id = ?").get(call.user_id), { digitConfirm: true })
      : await advanceSignup(call.state, speech, draft, { digitConfirm: true });

    upsertCall(callId, result.newUserId || call.user_id, result.nextState, result.draft || draft, result.outcome);

    if (result.hangup) {
      return text(ctx.res, 200, sayAndHangup(result.text));
    }
    return text(ctx.res, 200, sayAndReadStt(result.text));
  });
}

// ימות שולח את מספר המתקשר לרוב בפורמט מקומי (למשל "0501234567"), בעוד ש-Twilio שולח E.164 (+972501234567).
// כדי שאותו משתמש יזוהה בין שני ספקי הטלפוניה, בודקים כמה צורות כתיבה נפוצות של אותו מספר.
function findUserByPhone(rawPhone) {
  const candidates = phoneCandidates(rawPhone);
  for (const candidate of candidates) {
    const user = db.prepare("SELECT * FROM users WHERE phone = ? OR phone2 = ?").get(candidate, candidate);
    if (user) return user;
  }
  return null;
}

function phoneCandidates(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D/g, "");
  if (!digits) return [];
  const local = digits.startsWith("972") ? "0" + digits.slice(3) : digits; // 972501234567 -> 0501234567
  const noLeadingZero = local.replace(/^0/, ""); // 0501234567 -> 501234567
  return Array.from(
    new Set([rawPhone, digits, local, `+972${noLeadingZero}`, `972${noLeadingZero}`, local])
  ).filter(Boolean);
}

module.exports = { register };
