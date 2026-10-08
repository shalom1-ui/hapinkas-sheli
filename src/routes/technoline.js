// technoline.js (routes) — ערוץ שיחות נוסף: "מודול API" של טכנוליין (pbx.tlivr.com), במקום ימות המשיח.
// אותה מכונת מצבים בדיוק (advance/advanceSignup מ-routes/ivr.js) ואותו זיהוי מתקשר - רק פרוטוקול שונה.
// בניגוד לימות (טקסט), טכנוליין מקבלת JSON: המרכזייה פונה אלינו (GET/POST) עם PBXcallId/PBXphone/
// PBXcallStatus וכל ערך שביקשנו מהמתקשר תחת השם ("name") שקבענו, ואנחנו מחזירים מודול אחד (או מערך).
//
// לקחים מהפרויקט האחי cyber-yemot (src/tlivr.js), שכבר רץ חי מול הקו הזה:
//   - תפריט של ספרה אחת חייב להיות simpleMenu (getDTMF מחכה לסולמית), ורק קלט רב-ספרתי הוא getDTMF.
//   - לא להשתמש ב-removeParams - זה מנקה גם את ההקשה שהמתקשר הרגע הקיש.
//   - בהגדרות השלוחה בטכנוליין: "אופן שליחת ערכי המשתמש" = "אחרון בלבד" (ר' README).
//
// חלוקת השלבים: הקשות (תפריטים/אישורים/PIN/סכומים) - בדיוק כמו "מצב הקשות בלבד" בימות (ר' keypadResponse
// ב-routes/yemot.js), ורק שלבים שדורשים דיבור באמת עוברים לזיהוי הדיבור המובנה של טכנוליין (stt, עד 10
// שניות) או - לתוכן ארוך - להקלטה עם תמלול רך ברקע (record + sttSoft).
"use strict";

const db = require("../db");
const { json } = require("../router");
const {
  advance, advanceSignup, upsertCall, appendTranscript, mainMenuPrompt, OPENING_GREETING,
  DIGIT_ENTRY_STATES,
} = require("./ivr");
const { keypadizeText, findUserByPhone, FREE_TEXT_STATES, KEYPAD_OK_FREE_TEXT_STATES, KEYPAD_AMOUNT_STATES } = require("./yemot");

// שם הערך שבו המרכזייה מחזירה את מה שהמתקשר הקיש/אמר (ור' mapInput למטה)
const VAL = "val";

// שלבי תוכן חופשי וארוך (דיווח/הערה/טופס הכנה לשיעור) - לא נכנס ב-10 שניות של stt, ולכן הקלטה ארוכה
// עם תמלול רך ברקע. הטקסט חוזר ב-TEXT_<name> (ריק אם התמלול נכשל - הלוגיקה הרגילה תבקש שוב).
const LONG_TEXT_STATES = new Set([
  "therapist_note", "supervisor_readback", "mentor_note_speak",
  "lesson_prep_topic_studied_speak", "lesson_prep_goal_speak",
  "lesson_prep_practical_application_speak", "lesson_prep_connection_cooperation_speak",
]);

const STUDENT_NAME_STATES = new Set(["mentor_pick_student", "therapist_student", "supervisor_pick_student"]);

// מקשים שמותר להקיש בתפריט של ספרה אחת - כולל * (חזרה לתפריט הראשי) ו-0 (חלק מהתפריטים)
const MENU_KEYS = "0,1,2,3,4,5,6,7,8,9,*";

// כמה פניות ברצף בלי שום קלט (שקט/ERROR) לפני שמנתקים בנימוס - כדי שמתקשר שנעלם לא ישאיר שיחה מתנדנדת
const MAX_SILENT_TURNS = 3;

function files(text) {
  return [{ text: String(text || "").trim() }];
}

// בונה את המודול שיוחזר למרכזייה, לפי השלב הבא ב-state machine. פונקציה טהורה (נבדקת ישירות).
// extra.studentNames: שמות התלמידים של המשתמש - רמז זיהוי (bias) בלבד לשלבי בחירת שם תלמיד.
function buildModule(result, extra = {}) {
  const state = result.nextState;
  if (result.hangup) {
    return [{ type: "simpleMessage", files: files(result.text) }, { type: "hangup" }];
  }
  // קוד PIN (4 ספרות, לא מוקרא בקול ולא נשמר בלוג)
  if (DIGIT_ENTRY_STATES.has(state)) {
    return {
      type: "getDTMF", name: VAL, min: 4, max: 4, timeout: 5, skipKey: "#", confirmType: "no", maskLog: true,
      files: files(`${result.text} ובסיום הקישו סולמית.`),
    };
  }
  // סכום בשקלים - הקשת מספר באורך משתנה, מסתיים בסולמית
  if (KEYPAD_AMOUNT_STATES.has(state)) {
    return {
      type: "getDTMF", name: VAL, min: 1, max: 7, timeout: 5, skipKey: "#", confirmType: "no",
      files: files(keypadizeText(result.text, state)),
    };
  }
  // תוכן ארוך: הקלטה + תמלול רך ברקע
  if (LONG_TEXT_STATES.has(state)) {
    return {
      type: "record", name: VAL, max: 60, min: 1, confirm: "no", hangupSave: "yes", sttSoft: true,
      files: files(`${result.text} כשתסיימו לדבר, הקישו סולמית.`),
    };
  }
  // שאר שלבי הדיבור (שמות, סוג דיווח, "אחר" בקטגוריה): זיהוי הדיבור המובנה של טכנוליין (עד 10 שניות).
  // sttSnap:false - הרשימה היא רמז בלבד, לא "הצמדה" לערך הקרוב: אחרת שם תלמיד חדש (שעוד לא ברשימה)
  // היה מוצמד בטעות לתלמיד קיים ולא היה אפשר להוסיף אותו.
  if (FREE_TEXT_STATES.has(state) && !KEYPAD_OK_FREE_TEXT_STATES.has(state)) {
    const mod = { type: "stt", name: VAL, max: 10, files: files(result.text) };
    let phrases = null;
    if (state === "therapist_role") phrases = ["ריפוי בעיסוק", "טיפול רגשי", "אחר"];
    else if (STUDENT_NAME_STATES.has(state) && extra.studentNames && extra.studentNames.length) phrases = extra.studentNames;
    if (phrases) Object.assign(mod, { sttPhrases: phrases.join(","), sttSnap: false });
    return mod;
  }
  // כל השאר (תפריט ראשי, אחרי יתרה, אישורים, בחירות) - ספרה אחת
  return {
    type: "simpleMenu", name: VAL, enabledKeys: MENU_KEYS, times: 2, timeout: 7,
    files: files(keypadizeText(result.text, state)),
  };
}

// הקלט שחזר מהמרכזייה: לשלבי הקלטה ארוכה - הטקסט המתומלל (TEXT_val); אחרת הערך עצמו. "ERROR" (תם הזמן
// בתפריט) נחשב כשקט.
function mapInput(params, state) {
  const raw = LONG_TEXT_STATES.has(state) ? params[`TEXT_${VAL}`] : params[VAL];
  const v = String(raw == null ? "" : raw).trim();
  return v === "ERROR" ? "" : v;
}

function studentNamesFor(userId) {
  if (!userId) return [];
  return db.prepare("SELECT name FROM students WHERE owner_user_id = ? AND active = 1 ORDER BY name LIMIT 60").all(userId).map((r) => r.name);
}

async function handleTechnoline(ctx) {
  const p = { ...(ctx.query || {}), ...(ctx.body || {}) };
  const callId = p.PBXcallId;
  console.log(`[YEMOT-DEBUG] tlivr בקשה נכנסת: ${JSON.stringify(p)}`);
  if (!callId) return json(ctx.res, 200, { type: "hangup" });

  // ניתוק - אין מה להשיב (אצל טכנוליין זו פנייה נוספת לסיכום שיחה בלבד)
  if (p.PBXcallStatus === "HANGUP") return json(ctx.res, 200, []);

  const call = db.prepare("SELECT * FROM call_logs WHERE call_sid = ?").get(callId);

  // ---------- תחילת שיחה ----------
  if (!call) {
    const user = findUserByPhone(p.PBXphone);
    if (!user) {
      upsertCall(callId, null, "signup_name", { phone: p.PBXphone }, null, p.PBXphone);
      return json(ctx.res, 200, buildModule({
        text: `${OPENING_GREETING}מספר הטלפון שלך אינו מזוהה במערכת. אפשר להירשם עכשיו ישירות בטלפון, בלי לגשת לאתר. מה השם המלא שלכם?`,
        nextState: "signup_name",
      }));
    }
    upsertCall(callId, user.id, "main_menu", {}, null, p.PBXphone);
    return json(ctx.res, 200, buildModule({
      text: `${OPENING_GREETING}${mainMenuPrompt(user.full_name, { digitConfirm: true })}`,
      nextState: "main_menu",
    }));
  }

  // ---------- המשך שיחה ----------
  const draft = JSON.parse(call.draft_json || "{}");
  const speech = mapInput(p, call.state);
  appendTranscript(callId, speech);

  const silent = speech === "" ? (draft._tlSilent || 0) + 1 : 0;
  if (silent >= MAX_SILENT_TURNS) {
    upsertCall(callId, call.user_id, "done", draft, "no_input", p.PBXphone);
    return json(ctx.res, 200, buildModule({ text: "לא קלטנו תשובה. אפשר להתקשר שוב בכל עת. להתראות.", hangup: true }));
  }

  const opts = { digitConfirm: true, menuVoiceOnly: false };
  const result = call.user_id
    ? await advance(call.state, speech, draft, db.prepare("SELECT * FROM users WHERE id = ?").get(call.user_id), opts)
    : await advanceSignup(call.state, speech, draft, opts);

  upsertCall(callId, result.newUserId || call.user_id, result.nextState, { ...(result.draft || draft), _tlSilent: silent }, result.outcome, p.PBXphone);

  const extra = { studentNames: STUDENT_NAME_STATES.has(result.nextState) ? studentNamesFor(result.newUserId || call.user_id) : [] };
  return json(ctx.res, 200, buildModule(result, extra));
}

function register(router) {
  // המרכזייה שולחת GET כברירת מחדל (או POST אם הוגדר בשלוחה) - תומכים בשניהם.
  router.get("/api/ivr/technoline", handleTechnoline);
  router.post("/api/ivr/technoline", handleTechnoline);
}

module.exports = { register, buildModule, mapInput, LONG_TEXT_STATES };
