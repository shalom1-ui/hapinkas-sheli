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
const { advance, advanceSignup, upsertCall, appendTranscript, MAIN_MENU_HINTS, mainMenuPrompt, OPENING_GREETING, DIGIT_ENTRY_STATES } = require("./ivr");
const { sayAndReadStt, sayAndRecord, sayAndReadDigits, sayAndHangup, VAL_NAME } = require("../services/yemot");
const speechToText = require("../services/speechToText");

// שלבים שמבקשים טקסט חופשי גרידא (שם, לא קטגוריה/ספרה) - אין בהם שום קיצור הקשה בעל משמעות,
// ולכן אפשר להעביר אותם למנוע ה"הקלטה" של ימות (freeText ב-sayAndReadStt) לזיהוי דיבור מדויק
// ונדיב יותר, בלי לפגוע בקיצורי ההקשה בשום מקום אחר (הם ממילא לא רלוונטיים כאן).
// כשמוגדר "זיהוי דיבור משודרג" (speechToText.isConfigured() - ר' services/speechToText.js), אותם
// שלבים בדיוק עוברים למצב "record" גולמי + תמלול Whisper במקום מנוע ההקלטה-לזיהוי של ימות עצמו -
// ר' הערות בהמשך הקובץ במקומות שבהם נבדק FREE_TEXT_STATES.
const FREE_TEXT_STATES = new Set(["signup_name", "mentor_pick_student", "signup_email"]);

// בונה את תגובת הפרוטוקול לבקשת קלט טקסט חופשי (שם וכו') עבור שלב נתון - בוחר בין שלוש אפשרויות:
// (1) אם מוגדר זיהוי דיבור משודרג (Whisper) - מבקשים הקלטה גולמית (sayAndRecord) שנתמלל בעצמנו
//     בבקשה הבאה; (2) אחרת - מנוע ה"הקלטה-לזיהוי" הרגיל של ימות (freeText); (3) לשלבים שאינם
//     free-text כלל - זיהוי דיבור (stt) רגיל, כמו קודם.
function freeTextPrompt(callId, text_) {
  if (speechToText.isConfigured()) {
    const { path, fileName } = speechToText.recordingPath(callId);
    return sayAndRecord(text_, path, fileName);
  }
  return sayAndReadStt(text_, { freeText: true });
}

function register(router) {
  router.post("/api/ivr/yemot", async (ctx) => {
    const v = ctx.body || {};
    // לוג אבחון זמני: רושם בדיוק מה ימות שולח בכל בקשה (כולל השדה "speech" - שם מגיעה גם הקשת ספרות/
    // סולמית תוך כדי זיהוי דיבור) - כדי לבדוק בפועל (דרך "Logs" ב-Render) מה בדיוק קורה כשמקישים
    // סולמית בודדת. אפשר להסיר את השורה הזו בהמשך אחרי שהעניין יתברר.
    console.log(`[YEMOT-DEBUG] בקשה נכנסת: ${JSON.stringify(v)}`);
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
          freeTextPrompt(callId, `${OPENING_GREETING}מספר הטלפון שלך אינו מזוהה במערכת. אפשר להירשם עכשיו ישירות בטלפון, בלי לגשת לאתר. מה השם המלא שלכם?`)
        );
      }

      upsertCall(callId, user.id, "main_menu", {});
      return text(ctx.res, 200, sayAndReadStt(`${OPENING_GREETING}${mainMenuPrompt(user.full_name, { digitConfirm: true })}`));
    }

    // ---------- המשך שיחה קיימת ----------
    // אם השלב הקודם היה בקשת הקלטה גולמית (ר' freeTextPrompt) - הערך שימות שולחת בשדה "speech" הוא
    // לא הטקסט שהמתקשר אמר (ימות לא ניסתה בכלל לזהות דיבור במצב record), אלא ערך לא רלוונטי. במקום
    // זאת מורידים ומתמללים בעצמנו את ההקלטה שנשמרה (ר' services/speechToText.js). אם התמלול נכשל
    // מכל סיבה (למשל עדיין לא הוגדר בפועל, או שגיאת רשת) - נופלים בחזרה בבטחה לערך הגולמי שימות
    // שלחה, בדיוק כמו ההתנהגות הקודמת, כדי לא לתקוע את השיחה.
    let speech = String(v[VAL_NAME] || "").trim();
    if (FREE_TEXT_STATES.has(call.state) && speechToText.isConfigured()) {
      const transcribed = await speechToText.downloadAndTranscribe(callId);
      if (transcribed) {
        console.log(`[WHISPER-DEBUG] שימוש בתמלול Whisper במקום זיהוי הדיבור של ימות: "${transcribed}"`);
        speech = transcribed;
      } else {
        console.log("[WHISPER-DEBUG] תמלול נכשל/לא זמין - נופלים בחזרה לערך הגולמי מימות");
      }
    }
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
    if (DIGIT_ENTRY_STATES.has(result.nextState)) {
      return text(ctx.res, 200, sayAndReadDigits(result.text, 4));
    }
    if (FREE_TEXT_STATES.has(result.nextState)) {
      return text(ctx.res, 200, freeTextPrompt(callId, result.text));
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
