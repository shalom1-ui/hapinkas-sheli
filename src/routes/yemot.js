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
const { text, json } = require("../router");
const { advance, advanceSignup, upsertCall, appendTranscript, MAIN_MENU_HINTS, mainMenuPrompt, OPENING_GREETING, DIGIT_ENTRY_STATES } = require("./ivr");
const { sayAndReadStt, sayAndRecord, sayAndReadDigits, sayAndHangup, VAL_NAME } = require("../services/yemot");
const speechToText = require("../services/speechToText");
const debugLog = require("../debugLog");

// שלבים שמבקשים טקסט חופשי גרידא (שם, לא קטגוריה/ספרה) - אין בהם שום קיצור הקשה בעל משמעות,
// ולכן אפשר להעביר אותם למנוע ה"הקלטה" של ימות (freeText ב-sayAndReadStt) לזיהוי דיבור מדויק
// ונדיב יותר, בלי לפגוע בקיצורי ההקשה בשום מקום אחר (הם ממילא לא רלוונטיים כאן).
// כשמוגדר "זיהוי דיבור משודרג" (speechToText.isConfigured() - ר' services/speechToText.js), אותם
// שלבים בדיוק עוברים למצב "record" גולמי + תמלול Whisper במקום מנוע ההקלטה-לזיהוי של ימות עצמו -
// ר' הערות בהמשך הקובץ במקומות שבהם נבדק FREE_TEXT_STATES.
//
// "main_menu" נוסף כאן בעקבות תקלות חוזרות בפועל: התפריט הראשי (בחירת קטגוריה, שם/מילים כמו "ניהול
// חשבונות") הוא בדיוק המקום שבו מנוע הזיהוי המקורי של ימות נכשל הכי הרבה ("לא זוהה דיבור" שוב ושוב),
// כי המילים ארוכות/מורכבות יחסית. המחיר: **רק** במצב שבו Whisper מוגדר בפועל, הקשת ספרה בתפריט
// הראשי (1-6, ר' MAIN_MENU_DIGIT_KEYWORDS) מפסיקה לעבוד, כי מצב "הקלטה" חוסם הקשות לגמרי - ר' opts.menuVoiceOnly
// ב-mainMenuPrompt (routes/ivr.js) שמסיר גם את ההזכרה המילולית של האפשרות הזו במצב הזה, כדי לא להטעות.
const FREE_TEXT_STATES = new Set(["signup_name", "mentor_pick_student", "signup_email", "main_menu"]);

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
      const menuVoiceOnly = speechToText.isConfigured();
      return text(
        ctx.res,
        200,
        freeTextPrompt(callId, `${OPENING_GREETING}${mainMenuPrompt(user.full_name, { digitConfirm: true, menuVoiceOnly })}`)
      );
    }

    // ---------- המשך שיחה קיימת ----------
    // אם השלב הקודם היה בקשת הקלטה גולמית (ר' freeTextPrompt) - הערך שימות שולחת בשדה "speech" הוא
    // לא הטקסט שהמתקשר אמר (ימות לא ניסתה בכלל לזהות דיבור במצב record), אלא ערך לא רלוונטי. במקום
    // זאת מורידים ומתמללים בעצמנו את ההקלטה שנשמרה (ר' services/speechToText.js). אם התמלול נכשל
    // מכל סיבה (למשל עדיין לא הוגדר בפועל, או שגיאת רשת) - נופלים בחזרה בבטחה לערך הגולמי שימות
    // שלחה, בדיוק כמו ההתנהגות הקודמת, כדי לא לתקוע את השיחה.
    let speech = String(v[VAL_NAME] || "").trim();
    // באג אמיתי שתוקן כאן: כשמוגדר זיהוי דיבור משודרג (Whisper), שלב טקסט חופשי עובר למצב "record"
    // הגולמי של ימות (ר' freeTextPrompt) - ובמצב הזה השדה "speech" ש-ימות שולחת הוא **לא** דיבור
    // שזוהה בכלל, אלא ערך פנימי לא רלוונטי (בפועל: משהו כמו נתיב/שם הקובץ של ההקלטה עצמה, למשל
    // "0775325817/hp-...wav"). בעבר, כשהתמלול נכשל (למשל שגיאת 404 בהורדת ההקלטה), הקוד "נפל בחזרה"
    // לערך הגולמי הזה **כאילו** הוא מה שהמתקשר אמר - וזה גרם לתקלה אמיתית בפועל: השם שנשמר בפועל
    // בהרשמה היה מחרוזת קטע-נתיב חסרת משמעות, שגם הוקראה בחזרה למתקשר (ר' README/CHANGELOG). התיקון:
    // כשהתמלול נכשל *במצב record* (כלומר isConfigured()==true) - מתייחסים לזה כאילו לא נשמע כלום
    // (speech ריק), כדי שהלוגיקה הרגילה של "לא שמעתי שם, נסו שוב" תיכנס לפעולה - בלי לקבל זבל כתשובה.
    if (FREE_TEXT_STATES.has(call.state) && speechToText.isConfigured()) {
      const transcribed = await speechToText.downloadAndTranscribe(callId);
      if (transcribed) {
        console.log(`[WHISPER-DEBUG] שימוש בתמלול Whisper במקום זיהוי הדיבור של ימות: "${transcribed}"`);
        speech = transcribed;
      } else {
        console.log("[WHISPER-DEBUG] תמלול נכשל/לא זמין - מתייחסים לכך כאילו לא נשמע דיבור (לא נעשה שימוש בערך הגולמי - הוא לא טקסט אמיתי במצב record)");
        speech = "";
      }
    }
    appendTranscript(callId, speech);
    const draft = JSON.parse(call.draft_json || "{}");

    // digitConfirm: true - בימות אפשר להקיש (כולל סולמית) תוך כדי זיהוי דיבור בלי לחסום את זה
    // (ר' services/yemot.js / sayAndReadStt), אז מוסיפים אפשרות אישור מהירה בהקשה בכל שאלת "אמרו כן לאישור".
    // menuVoiceOnly: ר' הערה מפורטת ב-mainMenuPrompt (routes/ivr.js) - רק כשזה true מוסתרת ההזכרה
    // המילולית של הקשת 1-6 בתפריט הראשי (כי היא לא זמינה במצב הקלטה של Whisper); לשאר שאלות האישור
    // בשיחה (שאינן מצב הקלטה) זה לא משפיע - הן ממשיכות להשתמש ב-digitConfirm הרגיל.
    const opts = { digitConfirm: true, menuVoiceOnly: speechToText.isConfigured() };
    const result = call.user_id
      ? await advance(call.state, speech, draft, db.prepare("SELECT * FROM users WHERE id = ?").get(call.user_id), opts)
      : await advanceSignup(call.state, speech, draft, opts);

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

  // --- אבחון זמני: בדיקת הקלטות Whisper ישירות מול ימות (ר' README, סעיף "זיהוי דיבור משודרג") ---
  // נועד לענות סופית על השאלה "האם ההקלטה בכלל נשמרת אצל ימות, ואיפה בדיוק" - בלי להסתמך על ניווט
  // ידני מבלבל באתר הניהול של ימות (שקשה להסביר צעד-אחר-צעד למשתמש לא-טכני). קורא ל-API הרשמי
  // GetIVR2Dir של ימות (עם הטוקן שכבר מוגדר אצלנו כמשתנה סביבה) ומחזיר את רשימת הקבצים שנמצאים
  // בפועל בתיקיית השלוחה שאנחנו שומרים בה הקלטות (ר' services/speechToText.js, recordingPath).
  // מוגן במילת-מעבר קבועה בפרמטר key בכתובת (לא סוד אמיתי - רק כדי שלא כל מי שמנחש את הכתובת
  // יוכל לראות רשימת קבצים) - יש להסיר את הנתיב הזה אחרי שהתקלה תיפתר.
  const DEBUG_KEY = "hapinkas-diag-9427";
  router.get("/api/debug/yemot-dir", async (ctx) => {
    if (ctx.query.key !== DEBUG_KEY) {
      return json(ctx.res, 403, { error: "אין הרשאה - חסר או שגוי פרמטר key" });
    }
    if (!process.env.YEMOT_API_TOKEN) {
      return json(ctx.res, 400, { error: "חסר משתנה סביבה YEMOT_API_TOKEN" });
    }
    const ext = process.env.YEMOT_EXTENSION_NUMBER || "";
    const targetPath = ctx.query.path || ext || "/";
    try {
      const url = `https://www.call2all.co.il/ym/api/GetIVR2Dir?token=${encodeURIComponent(process.env.YEMOT_API_TOKEN)}&path=${encodeURIComponent(targetPath)}`;
      const yemotRes = await fetch(url);
      const rawText = await yemotRes.text();
      let data;
      try { data = JSON.parse(rawText); } catch { data = { rawResponse: rawText }; }
      return json(ctx.res, 200, {
        checkedPath: targetPath,
        yemotExtensionEnv: ext,
        httpStatus: yemotRes.status,
        yemotResponse: data,
      });
    } catch (e) {
      return json(ctx.res, 500, { error: e.message });
    }
  });

  // --- אבחון זמני, גרסה מהירה: הכל בכתובת אחת ---
  // במקום "תתקשר -> תיכנס ל-Render -> תצלם מסך של Logs -> תשלח" בכל פעם, מסך אחד שמראה גם את
  // שורות ה-[YEMOT-DEBUG]/[WHISPER-DEBUG] האחרונות (מ-debugLog, ר' שם) וגם את רשימת הקבצים
  // העדכנית בתיקיית השלוחה (GetIVR2Dir) - טקסט פשוט שאפשר להעתיק-להדביק ישירות, בלי צילום מסך.
  router.get("/api/debug/yemot-recent", async (ctx) => {
    if (ctx.query.key !== DEBUG_KEY) {
      return json(ctx.res, 403, { error: "אין הרשאה - חסר או שגוי פרמטר key" });
    }
    const lines = debugLog.getAll();
    const logsText = lines.length
      ? lines.map((e) => `${e.time}  ${e.line}`).join("\n")
      : "(אין עדיין שורות אבחון בזיכרון - יתאפסו אחרי כל פריסה/הפעלה מחדש של השרת; תתקשר קודם ואז תרענן את הדף הזה)";

    let filesText = "(לא נבדק - חסר YEMOT_API_TOKEN)";
    if (process.env.YEMOT_API_TOKEN) {
      const ext = process.env.YEMOT_EXTENSION_NUMBER || "";
      const targetPath = ctx.query.path || ext || "/";
      try {
        const url = `https://www.call2all.co.il/ym/api/GetIVR2Dir?token=${encodeURIComponent(process.env.YEMOT_API_TOKEN)}&path=${encodeURIComponent(targetPath)}`;
        const yemotRes = await fetch(url);
        const rawText = await yemotRes.text();
        filesText = rawText;
      } catch (e) {
        filesText = `שגיאה בבדיקת קבצים: ${e.message}`;
      }
    }

    return text(
      ctx.res,
      200,
      `=== שורות אבחון אחרונות (מהזיכרון, מתאפסות בכל פריסה מחדש) ===\n${logsText}\n\n=== רשימת קבצים נוכחית בשלוחה (GetIVR2Dir) ===\n${filesText}\n`
    );
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
