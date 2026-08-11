// test-flow.js — בדיקה אוטומטית מקצה לקצה. מריצה שרת אמיתי על פורט זמני, מבצעת קריאות HTTP
// אמיתיות (בלי שום ספרייה חיצונית, רק fetch גלובלי), ובודקת שכל הזרימות המרכזיות עובדות.
// הרצה: npm test  (או: node tests/test-flow.js)
"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const TEST_PORT = 3999;
const BASE = `http://localhost:${TEST_PORT}`;
const TEST_DB = path.join(__dirname, "test.db");
const TEST_UPLOADS_DIR = path.join(__dirname, "test-uploads"); // תיקייה זמנית, לא תיקיית data/uploads האמיתית - נמחקת בסוף

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.log(`  ❌ ${message}`);
  }
}

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore (e.g. TwiML XML) */ }
  return { status: res.status, data };
}

async function ivrCall(callSid, from) {
  const res = await fetch(`${BASE}/api/ivr/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: from, CallSid: callSid }),
  });
  return res.text();
}

async function ivrSay(callSid, speech) {
  const res = await fetch(`${BASE}/api/ivr/handle`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ CallSid: callSid, SpeechResult: speech }),
  });
  return res.text();
}

// מדמה הקשת מקלדת (DTMF) דרך Twilio - שדה "Digits", לא "SpeechResult" (ר' DIGIT_ENTRY_STATES/
// sayAndGatherDigits ב-routes/ivr.js ו-services/telephony.js). בדיוק מה שה-<Gather> במצב dtmf שולח בפועל.
async function ivrTapDigits(callSid, digits) {
  const res = await fetch(`${BASE}/api/ivr/handle`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ CallSid: callSid, Digits: digits }),
  });
  return res.text();
}

// מדמה בקשת "ימות המשיח" (שלוחת API) - אותה כתובת בכל שלב, עם ApiCallId קבוע לאורך השיחה
// ו-"speech" בלבד כשלב המשך (בדיוק כמו שהשרת שלנו מצפה - ר' services/yemot.js).
async function yemotCall({ callId, phone, speech }) {
  const params = { ApiCallId: callId, ApiPhone: phone || "", ApiDID: "0775325817", ApiExtension: "1" };
  if (typeof speech === "string") params.speech = speech;
  const res = await fetch(`${BASE}/api/ivr/yemot`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return res.text();
}

async function run() {
  console.log("🧪 מתחיל בדיקות מקצה לקצה — הפנקס שלי\n");

  // מסד נתונים נקי לבדיקה
  for (const suffix of ["", "-shm", "-wal"]) {
    if (fs.existsSync(TEST_DB + suffix)) fs.unlinkSync(TEST_DB + suffix);
  }

  const server = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
    env: { ...process.env, PORT: String(TEST_PORT), DB_PATH: TEST_DB, UPLOADS_DIR: TEST_UPLOADS_DIR, RECOVERY_MOCK: "true", CARDCOM_MOCK: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("השרת לא עלה בזמן")), 8000);
    server.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("פועל על פורט")) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on("data", (chunk) => { /* אזהרות ExperimentalWarning - מתעלמים */ });
  });

  try {
    console.log("👤 הרשמה והתחברות");
    const signup = await api("POST", "/api/auth/signup", {
      full_name: "בדיקה אוטומטית", phone: "+972500000001", email: "test@example.com",
      username: `tester_${Date.now()}`, password: "1234",
    });
    assert(signup.status === 201 && signup.data.token, "הרשמת משתמש חדש הצליחה");
    const token = signup.data.token;
    const username = signup.data.user.username;

    const login = await api("POST", "/api/auth/login", { username, password: "1234" });
    assert(login.status === 200 && login.data.token, "התחברות עם סיסמה נכונה הצליחה");

    const badLogin = await api("POST", "/api/auth/login", { username, password: "wrong" });
    assert(badLogin.status === 401, "התחברות עם סיסמה שגויה נדחתה כראוי");

    // סיסמה חייבת להיות בדיוק קוד בן 4 ספרות (ר' isValidPin ב-utils/crypto.js) - כדי שאותה סיסמה
    // תעבוד גם כקוד PIN בטלפון (ר' routes/ivr.js, signup_pin) ולהפך. נבדק כאן בכל שלושת המקומות
    // שקובעים סיסמה: הרשמה באתר, שחזור סיסמה, ושינוי סיסמה למשתמש מחובר.
    const badFormatSignup = await api("POST", "/api/auth/signup", {
      full_name: "סיסמה לא תקינה", username: `badpw_${Date.now()}`, password: "abc123",
    });
    assert(badFormatSignup.status === 400, "הרשמה באתר עם סיסמה שאינה בדיוק 4 ספרות נדחית");
    const shortFormatSignup = await api("POST", "/api/auth/signup", {
      full_name: "סיסמה קצרה מדי", username: `shortpw_${Date.now()}`, password: "123",
    });
    assert(shortFormatSignup.status === 400, "הרשמה באתר עם סיסמה קצרה מ-4 ספרות נדחית");

    console.log("\n🔑 שחזור סיסמה בשיחה קולית (ללא SMS)");
    const fpReq = await api("POST", "/api/auth/forgot-password/request", { username, channel: "phone" });
    assert(fpReq.status === 200 && fpReq.data.demoCode, "בקשת שחזור סיסמה החזירה קוד דמו (מצב MOCK)");
    const fpVerify = await api("POST", "/api/auth/forgot-password/verify", { username, code: fpReq.data.demoCode });
    assert(fpVerify.status === 200 && fpVerify.data.resetToken, "אימות קוד השחזור הצליח");
    const fpResetBadFormat = await api("POST", "/api/auth/forgot-password/reset", { resetToken: fpVerify.data.resetToken, newPassword: "12345" });
    assert(fpResetBadFormat.status === 400, "שחזור סיסמה עם קוד שאינו בדיוק 4 ספרות נדחה");
    const fpReset = await api("POST", "/api/auth/forgot-password/reset", { resetToken: fpVerify.data.resetToken, newPassword: "9999" });
    assert(fpReset.status === 200, "קביעת סיסמה חדשה הצליחה");
    const loginNew = await api("POST", "/api/auth/login", { username, password: "9999" });
    assert(loginNew.status === 200, "התחברות עם הסיסמה החדשה הצליחה");

    const changePwBadFormat = await api("PUT", "/api/me/password", { currentPassword: "9999", newPassword: "abcd" }, token);
    assert(changePwBadFormat.status === 400, "שינוי סיסמה למשתמש מחובר עם ערך שאינו בדיוק 4 ספרות נדחה");
    const changePwOk = await api("PUT", "/api/me/password", { currentPassword: "9999", newPassword: "4444" }, token);
    assert(changePwOk.status === 200, "שינוי סיסמה למשתמש מחובר עם קוד 4 ספרות תקין הצליח");

    console.log("\n👑 תביעת 'בעל הקו' (admin) - לא 'המשתמש הראשון שנרשם', אלא מי שנרשם באתר עצמו ומאמת טלפון");
    // חשבון שנוצר דרך הטלפון (signup_channel='phone') לא כשיר לתבוע בעל הקו, גם אם הוא "המשתמש הראשון"
    // באיזשהו מובן - בודקים את זה ע"י יצירת משתמש כזה, קביעת סיסמה ידועה דרך שחזור סיסמה (כדי שנוכל
    // בכלל להתחבר אליו ולקבל טוקן), ואז ניסיון תביעה שאמור להידחות.
    const phoneOnlyCallSid = `ADMIN-CLAIM-TEST-${Date.now()}`;
    const phoneOnlyPhone = "+972500000066";
    await ivrCall(phoneOnlyCallSid, phoneOnlyPhone);
    await ivrSay(phoneOnlyCallSid, "מהטלפון בלבד");
    await ivrSay(phoneOnlyCallSid, "כן");
    await ivrSay(phoneOnlyCallSid, "2222");
    await ivrSay(phoneOnlyCallSid, "2222");
    await ivrSay(phoneOnlyCallSid, "דלג");
    const phoneOnlyUsername = `phone_${phoneOnlyPhone.replace(/\D/g, "").slice(-9)}`;
    const phoneOnlyResetReq = await api("POST", "/api/auth/forgot-password/request", { username: phoneOnlyUsername, channel: "phone" });
    assert(phoneOnlyResetReq.status === 200 && phoneOnlyResetReq.data.demoCode, "אפשר לשחזר סיסמה לחשבון שנוצר מהטלפון (כדי להתחבר אליו לצורך הבדיקה)");
    const phoneOnlyVerify = await api("POST", "/api/auth/forgot-password/verify", { username: phoneOnlyUsername, code: phoneOnlyResetReq.data.demoCode });
    await api("POST", "/api/auth/forgot-password/reset", { resetToken: phoneOnlyVerify.data.resetToken, newPassword: "1234" });
    const phoneOnlyLogin = await api("POST", "/api/auth/login", { username: phoneOnlyUsername, password: "1234" });
    assert(phoneOnlyLogin.status === 200, "התחברות לחשבון שנוצר מהטלפון (אחרי קביעת סיסמה) הצליחה");
    const phoneOnlyClaimAttempt = await api("POST", "/api/me/request-admin-claim", {}, phoneOnlyLogin.data.token);
    assert(
      phoneOnlyClaimAttempt.status === 403,
      "חשבון שנוצר דרך הטלפון (לא נרשם באתר עצמו) לא יכול לתבוע את תפקיד בעל הקו, גם אם יש לו טלפון וסיסמה"
    );

    const claimStatusBefore = await api("GET", "/api/me/admin-claim-status", null, token);
    assert(
      claimStatusBefore.data.adminExists === false && claimStatusBefore.data.eligible === true,
      "לפני שיש בעל קו כלשהו: משתמש שנרשם באתר עצמו ויש לו טלפון רשום כשיר לתבוע את התפקיד"
    );

    const noPhoneSignup = await api("POST", "/api/auth/signup", {
      full_name: "בלי טלפון", username: `no_phone_${Date.now()}`, password: "1234",
    });
    const noPhoneClaimAttempt = await api("POST", "/api/me/request-admin-claim", {}, noPhoneSignup.data.token);
    assert(noPhoneClaimAttempt.status === 400, "משתמש בלי מספר טלפון רשום לא יכול לתבוע את בעל הקו (אין ערוץ לאמת אותו)");

    const wrongClaimCode = await api("POST", "/api/me/request-admin-claim", {}, token);
    assert(wrongClaimCode.status === 200 && wrongClaimCode.data.demoCode, "בקשת תביעת בעל הקו שולחת קוד אישור בשיחה קולית (demoCode במצב MOCK)");
    const wrongClaimConfirm = await api("POST", "/api/me/confirm-admin-claim", { code: "0000" }, token);
    assert(wrongClaimConfirm.status === 400, "קוד שגוי לא מאשר תביעת בעל הקו");
    const rightClaimConfirm = await api("POST", "/api/me/confirm-admin-claim", { code: wrongClaimCode.data.demoCode }, token);
    assert(
      rightClaimConfirm.status === 200 && rightClaimConfirm.data.user.roles.includes("admin"),
      "קוד נכון מאשר את התביעה בפועל - המשתמש (שנרשם באתר עם טלפון משלו) הופך ל'בעל הקו'"
    );

    const secondClaimAttempt = await api("POST", "/api/me/request-admin-claim", {}, noPhoneSignup.data.token);
    assert(secondClaimAttempt.status === 409, "אחרי שכבר יש בעל קו, אף אחד אחר לא יכול לתבוע את התפקיד (409)");

    console.log("\n👑 תפקיד 'מפקח' - לא ניתן להצהרה עצמית, רק דרך אישור בעל הקו");
    const supervisorViaSignup = await api("POST", "/api/auth/signup", {
      full_name: "מנסה להיות מפקח בהרשמה", username: `sneaky_signup_${Date.now()}`, password: "1234", roles: "mentor,supervisor",
    });
    assert(
      supervisorViaSignup.data.user.roles.includes("mentor") && !supervisorViaSignup.data.user.roles.includes("supervisor"),
      "לא ניתן להצהיר על עצמך כ'מפקח' ישירות בהרשמה - התפקיד מסונן, שאר התפקידים (mentor) כן מתקבלים"
    );

    const supervisorViaProfile = await api("PUT", "/api/me", { roles: "mentor,supervisor" }, supervisorViaSignup.data.token);
    assert(
      supervisorViaProfile.data.user.roles.includes("mentor") && !supervisorViaProfile.data.user.roles.includes("supervisor"),
      "לא ניתן להצהיר על עצמך כ'מפקח' ישירות דרך עדכון פרופיל (/api/me) - אותה הגנה"
    );

    const wrongAdminPhone = await api("POST", "/api/me/request-supervisor", { admin_phone: "0500000000" }, supervisorViaSignup.data.token);
    assert(
      wrongAdminPhone.status === 200 && !wrongAdminPhone.data.demoCode,
      "מספר טלפון שגוי של 'בעל הקו' מחזיר תשובה גנרית (200, בלי קוד) - לא חושף אם המספר נכון או לא"
    );

    const rightAdminPhone = await api("POST", "/api/me/request-supervisor", { admin_phone: "+972500000001" }, supervisorViaSignup.data.token);
    assert(rightAdminPhone.status === 200 && rightAdminPhone.data.demoCode, "מספר הטלפון הנכון של בעל הקו שולח קוד אישור (מוחזר כ-demoCode במצב MOCK)");

    const wrongCodeConfirm = await api("POST", "/api/me/confirm-supervisor", { code: "0000" }, supervisorViaSignup.data.token);
    assert(wrongCodeConfirm.status === 400, "קוד שגוי לא מאשר את הבקשה");

    const rightCodeConfirm = await api("POST", "/api/me/confirm-supervisor", { code: rightAdminPhone.data.demoCode }, supervisorViaSignup.data.token);
    assert(
      rightCodeConfirm.status === 200 && rightCodeConfirm.data.user.roles.includes("supervisor"),
      "הזנת הקוד הנכון (שהתקבל מבעל הקו) מאשרת בפועל את תפקיד המפקח"
    );

    const supervisorProfileAfterSave = await api("PUT", "/api/me", { full_name: "מנסה להיות מפקח בהרשמה" }, supervisorViaSignup.data.token);
    assert(
      supervisorProfileAfterSave.data.user.roles.includes("supervisor"),
      "שמירת פרופיל רגילה (בלי לגעת בתפקידים) לא 'שוכחת'/מסירה בטעות תפקיד מפקח שכבר אושר"
    );

    console.log("\n👤 עדכון פרופיל חלקי (שדה בודד, בלי שאר השדות)");
    // בדיקה שנוספה בעקבות באג אמיתי שנתגלה: עדכון עם שדה יחיד בלבד (למשל טלפון) קרס בעבר
    // כי node:sqlite לא מקבל undefined כפרמטר, ושאר השדות לא נשלחו בבקשה.
    const updatePhone = await api("PUT", "/api/me", { phone: "+972529999999" }, token);
    assert(updatePhone.status === 200 && updatePhone.data.user.phone === "+972529999999", "עדכון טלפון בלבד (בלי שאר השדות) הצליח ולא קרס");
    assert(updatePhone.data.user.full_name === "בדיקה אוטומטית", "שדות שלא נשלחו נשארו ללא שינוי");
    // מחזירים את הטלפון למספר המקורי כדי לא להשפיע על בדיקות ה-IVR שבהמשך
    await api("PUT", "/api/me", { phone: "+972500000001" }, token);

    console.log("\n💰 ניהול תקציב אישי");
    const expense = await api("POST", "/api/transactions", { type: "expense", amount: 120, category: "מזון" }, token);
    assert(expense.status === 201, "הוספת הוצאה הצליחה");
    const income = await api("POST", "/api/transactions", { type: "income", amount: 3000 }, token);
    assert(income.status === 201, "הוספת הכנסה הצליחה");
    const list = await api("GET", "/api/transactions", null, token);
    assert(list.data.summary.balance === 2880, `היתרה חושבה נכון (${list.data.summary.balance} === 2880)`);

    console.log("\n🙏 חישוב מעשרות אוטומטי (10% מההכנסות)");
    assert(list.data.tithe && list.data.tithe.obligation === 300, `חובת המעשר חושבה נכון כ-10% מההכנסות (${list.data.tithe && list.data.tithe.obligation} === 300)`);
    assert(list.data.tithe.paid === 0, "עדיין לא נרשם תשלום מעשרות, אז 'כבר ניתן' הוא 0");
    assert(list.data.tithe.remaining === 300, "נותר לתת שווה לכל חובת המעשר כשעוד לא ניתן כלום");
    const titheExpense = await api("POST", "/api/transactions", { type: "expense", amount: 120, category: "מעשרות" }, token);
    assert(titheExpense.status === 201, "רישום הוצאת מעשרות הצליח");
    const charityExpense = await api("POST", "/api/transactions", { type: "expense", amount: 50, category: "צדקה" }, token);
    assert(charityExpense.status === 201, "רישום הוצאת צדקה הצליח (קטגוריה נפרדת מ'מעשרות')");
    const listAfterTithe = await api("GET", "/api/transactions", null, token);
    assert(listAfterTithe.data.tithe.paid === 120, `'כבר ניתן' עודכן לפי הוצאת המעשרות בלבד, לא כולל צדקה (${listAfterTithe.data.tithe.paid} === 120)`);
    assert(listAfterTithe.data.tithe.remaining === 180, `'נותר לתת' חושב נכון: חובה 300 פחות 120 שכבר ניתנו = 180 (${listAfterTithe.data.tithe.remaining} === 180)`);
    assert(listAfterTithe.data.byCategory["צדקה"] === 50, "הוצאת הצדקה מופיעה בפילוח הוצאות לפי קטגוריה בנפרד");

    console.log("\n🎓 חונכות ותלמידים");
    const student = await api("POST", "/api/students", { name: "תלמיד בדיקה" }, token);
    assert(student.status === 201, "הוספת תלמיד הצליחה");
    const sid = student.data.student.id;

    const checkin = await api("POST", `/api/students/${sid}/checkin`, {}, token);
    assert(checkin.status === 200, "צ'ק-אין הצליח");
    const doubleCheckin = await api("POST", `/api/students/${sid}/checkin`, {}, token);
    assert(doubleCheckin.status === 409, "צ'ק-אין כפול נחסם כראוי");
    const checkout = await api("POST", `/api/students/${sid}/checkout`, { note: "עבדנו על חיבור וחיסור, התקדמות יפה" }, token);
    assert(checkout.status === 200 && checkout.data.session.duration_minutes >= 0, "צ'ק-אאוט חישב משך מפגש");
    assert(
      checkout.data.session.note === "עבדנו על חיבור וחיסור, התקדמות יפה",
      "דיווח המעקב החופשי של החונך על המפגש נשמר יחד עם הצ'ק-אאוט"
    );

    const quick = await api("POST", `/api/students/${sid}/quick-session`, {}, token);
    assert(quick.status === 201 && quick.data.session.duration_minutes === 45, "מפגש מהיר השתמש בברירת המחדל (45 דק')");
    assert(quick.data.session.note === null, "מפגש מהיר בלי דיווח מעקב נשמר בלי בעיה (השדה אופציונלי)");

    const sessionNoteDictionary = await api("GET", "/api/reports/dictionary?kind=session_note", null, token);
    assert(
      sessionNoteDictionary.status === 200 && sessionNoteDictionary.data.phrases.includes("עבדנו על חיבור וחיסור, התקדמות יפה"),
      "מילון דיווחי המעקב של החונך כולל את הניסוח שהוזן, לשימוש עם תלמידים הבאים"
    );

    console.log("\n🩺 מעגל מטפלים ותיק מאוחד");
    const report = await api("POST", `/api/students/${sid}/reports`, { role_type: "ריפוי בעיסוק", note: "התקדמות יפה", trend: "משתפרת" }, token);
    assert(report.status === 201, "הוספת דוח טיפולי הצליחה");
    const comment = await api("POST", `/api/students/${sid}/comments`, { text: "הערת מפקח לדוגמה" }, token);
    assert(comment.status === 201, "הוספת הערה (צ'אט פנימי) הצליחה");

    const strangerSignup0 = await api("POST", "/api/auth/signup", {
      full_name: "משתמש זר מוקדם", username: `stranger0_${Date.now()}`, password: "1234",
    });
    const strangerToken0 = strangerSignup0.data.token;

    console.log("\n📋 טופס \"הכנה לשיעור\" (חונכות) - דיגיטציה של הטופס הנייר");
    const lessonReport = await api(
      "POST",
      `/api/students/${sid}/lesson-reports`,
      {
        lesson_date: "יג כסלו", teacher_name: "בדיקה אוטומטית", teacher_phone: "+972500000001",
        convenient_hours: "אחה\"צ 16:00-18:00", study_days: "שני, רביעי",
        week_number: 7, meeting_number: 21, study_duration_minutes: 30,
        topic_studied: "גמ' השוכר את האומנין", goal: "מיקוד ושלבי ההבנה",
        work_method: "למידה הגיונית ואסטרטגית", practical_application: "יישום בפועל לדוגמה",
        connection_cooperation: "יש חיבור ושיתוף פעולה", coping_achieving_goals: "מתמודד יפה",
        environment_comments: "", lateness: "אין", absences: "אין",
      },
      token
    );
    assert(lessonReport.status === 201, "הוספת טופס \"הכנה לשיעור\" הצליחה");
    assert(
      lessonReport.data.lesson_report.topic_studied === "גמ' השוכר את האומנין",
      "השדות החופשיים בטופס נשמרו כמו שהם"
    );

    const lessonDictionary = await api("GET", "/api/lesson-reports/dictionary?kind=lesson_topic_studied", null, token);
    assert(
      lessonDictionary.status === 200 && lessonDictionary.data.phrases.includes("גמ' השוכר את האומנין"),
      "מילון הניסוחים של טופס ההכנה לשיעור כולל את הניסוח שהוזן, לתלמידים הבאים"
    );

    const strangerLessonReport = await api(
      "POST",
      `/api/students/${sid}/lesson-reports`,
      { topic_studied: "ניסיון לא מורשה" },
      strangerToken0
    );
    assert(strangerLessonReport.status === 403, "משתמש זר לא יכול להוסיף טופס הכנה לשיעור לתלמיד שאינו שלו");

    console.log("\n📎 העלאת מסמכים לתיק תלמיד");
    const fakeFileContent = Buffer.from("תוכן קובץ לבדיקה - טופס הכנה לשיעור סרוק", "utf8").toString("base64");
    const uploadDoc = await api(
      "POST",
      `/api/students/${sid}/documents`,
      { title: "טופס הכנה לשיעור - סרוק", filename: "form.txt", mime_type: "text/plain", data_base64: fakeFileContent },
      token
    );
    assert(uploadDoc.status === 201, "העלאת מסמך לתיק התלמיד הצליחה");
    const docId = uploadDoc.data.document.id;

    const docsList = await api("GET", `/api/students/${sid}/documents`, null, token);
    assert(
      docsList.status === 200 && docsList.data.documents.some(d => d.id === docId && d.title === "טופס הכנה לשיעור - סרוק"),
      "רשימת המסמכים מציגה את הכותרת של המסמך שהועלה"
    );
    assert(
      docsList.data.documents.every(d => d.content === undefined && d.data_base64 === undefined),
      "רשימת המסמכים מציגה רק כותרות/מטא-דאטה, לא את תוכן הקובץ עצמו"
    );

    const downloadDoc = await api("GET", `/api/documents/${docId}/download`, null, token);
    assert(downloadDoc.status === 200, "הורדת המסמך המלא הצליחה (בנפרד מהרשימה)");

    const strangerUpload = await api(
      "POST",
      `/api/students/${sid}/documents`,
      { title: "ניסיון לא מורשה", data_base64: fakeFileContent },
      strangerToken0
    );
    assert(strangerUpload.status === 403, "משתמש זר לא יכול להעלות מסמך לתלמיד שאינו שלו");

    const strangerDownload = await api("GET", `/api/documents/${docId}/download`, null, strangerToken0);
    assert(strangerDownload.status === 403, "משתמש זר לא יכול להוריד מסמך של תלמיד שאינו שלו");

    const file = await api("GET", `/api/students/${sid}/file`, null, token);
    assert(
      file.data.timeline.length === 6,
      `התיק המאוחד מכיל את כל הפריטים (${file.data.timeline.length} === 6: 2 מפגשים + דוח + הערה + טופס הכנה לשיעור + מסמך)`
    );

    console.log("\n👪 הורים - גישה לסיכום בלבד, לא לצ'אט הפנימי");
    const parentSignup = await api("POST", "/api/auth/signup", {
      full_name: "הורה לדוגמה", username: `parent_${Date.now()}`, password: "1234", email: "parent@example.com",
    });
    const parentToken = parentSignup.data.token;
    const parentUsername = parentSignup.data.user.username;

    const strangerSignup = await api("POST", "/api/auth/signup", {
      full_name: "משתמש זר", username: `stranger_${Date.now()}`, password: "1234",
    });
    const strangerToken = strangerSignup.data.token;

    const addGuardianByStranger = await api("POST", `/api/students/${sid}/guardians`, { username: parentUsername }, strangerToken);
    assert(addGuardianByStranger.status === 403, "משתמש זר בלי תפקיד מקצועי (roles='private' בלבד) לא יכול לשייך הורה לתלמיד - כולל הורה שמנסה לשייך את עצמו");

    const otherProfessionalSignup = await api("POST", "/api/auth/signup", {
      full_name: "מטפל אחר בצוות", username: `other_pro_${Date.now()}`, password: "1234", roles: "therapist",
    });
    const addGuardianByOtherProfessional = await api(
      "POST", `/api/students/${sid}/guardians`, { username: parentUsername }, otherProfessionalSignup.data.token
    );
    assert(
      addGuardianByOtherProfessional.status === 201,
      "איש צוות מקצועי אחר (לאו דווקא הבעלים המקורי) יכול גם הוא לשייך הורה לתלמיד"
    );
    const addGuardian = await api("POST", `/api/students/${sid}/guardians`, { username: parentUsername }, token);
    assert(addGuardian.status === 409, "אחרי ששויך כבר פעם אחת (ע\"י איש צוות אחר), ניסיון שיוך כפול נחסם כראוי (409)");

    console.log("\n📧 עדכון הורה במייל כשמתקבל דוח התקדמות חדש");
    const secondReport = await api("POST", `/api/students/${sid}/reports`, { role_type: "טיפול רגשי", note: "שיפור ניכר השבוע", trend: "משתפרת" }, token);
    assert(secondReport.status === 201, "דיווח שני נשמר בהצלחה");
    const guardianNotification = secondReport.data.notified_guardians?.find(n => n.email === "parent@example.com");
    assert(!!guardianNotification && guardianNotification.ok === true && guardianNotification.mock === true, "ההורה קיבל התראה במייל (מצב MOCK) על דוח עם מגמת שיפור");

    const stableReport = await api("POST", `/api/students/${sid}/reports`, { role_type: "אחר", note: "ללא שינוי מיוחד", trend: "יציבה" }, token);
    assert(stableReport.status === 201 && stableReport.data.notified_guardians.length === 0, "דוח עם מגמה יציבה (לא שיפור) לא שולח מייל להורה");

    console.log("\n✉️ שליטה ידנית: שמירה בלי שליחה, ושליחה מאוחרת בנפרד");
    const musicReport = await api(
      "POST",
      `/api/students/${sid}/reports`,
      { role_type: "תרפיה במוסיקה", note: "התקדמות מצוינת בתרפיה במוסיקה", trend: "משתפרת", notify_guardians: false },
      token
    );
    assert(musicReport.status === 201, "דיווח מסוג 'תרפיה במוסיקה' התקבל (סוג דיווח חדש)");
    assert(
      musicReport.data.notified_guardians.length === 0,
      "למרות מגמת שיפור, notify_guardians=false מנע שליחת מייל מיידית (שמירה בלי שליחה)"
    );

    const laterNotify = await api("POST", `/api/reports/${musicReport.data.report.id}/notify`, {}, token);
    assert(laterNotify.status === 200, "שליחת עדכון מאוחרת על דוח קיים הצליחה");
    const laterNotification = laterNotify.data.notified_guardians?.find((n) => n.email === "parent@example.com");
    assert(!!laterNotification && laterNotification.ok === true, "ההורה קיבל בפועל את המייל המאוחר על דוח שנשמר בלי שליחה");

    const forcedSend = await api(
      "POST",
      `/api/students/${sid}/reports`,
      { role_type: "תרפיה באומנות", note: "מפגש טוב, יציב", trend: "יציבה", notify_guardians: true },
      token
    );
    assert(forcedSend.status === 201, "דיווח מסוג 'תרפיה באומנות' התקבל (סוג דיווח חדש)");
    assert(
      forcedSend.data.notified_guardians.some((n) => n.email === "parent@example.com" && n.ok === true),
      "notify_guardians=true שולח מייל גם כשהמגמה אינה 'משתפרת' (שליטה ידנית עוקפת את ברירת המחדל)"
    );

    const strangerTriesNotify = await api("POST", `/api/reports/${musicReport.data.report.id}/notify`, {}, strangerToken);
    assert(strangerTriesNotify.status === 403, "משתמש זר לא יכול לשלוח עדכון ידני על דוח שאינו שלו ואינו על תלמיד שלו");

    console.log("\n📖 מילון ניסוחים אישי (השלמה אוטומטית לתלמידים הבאים)");
    const customTrendReport = await api(
      "POST",
      `/api/students/${sid}/reports`,
      { role_type: "תרפיה בחיות", note: "התחברות יפה עם הכלב הטיפולי", trend: "שיפור קל אך מורגש", notify_guardians: false },
      token
    );
    assert(customTrendReport.status === 201, "דיווח מסוג 'תרפיה בחיות' עם מגמה בניסוח חופשי (לא אחת משלושת הקבועות) התקבל");
    assert(
      customTrendReport.data.report.trend === "שיפור קל אך מורגש",
      "המגמה בניסוח החופשי נשמרה כמו שהיא (לא נדרסה ל'יציבה')"
    );

    const noteDictionary = await api("GET", "/api/reports/dictionary?kind=note", null, token);
    assert(
      noteDictionary.status === 200 && noteDictionary.data.phrases.includes("התקדמות יפה"),
      "מילון תוכן הדיווח כולל ניסוח שהוזן בעבר, לשימוש עם תלמידים הבאים"
    );

    const trendDictionary = await api("GET", "/api/reports/dictionary?kind=trend", null, token);
    assert(
      trendDictionary.status === 200 && trendDictionary.data.phrases.includes("שיפור קל אך מורגש"),
      "מילון המגמות כולל את הניסוח החופשי שהוזן תחת 'אחר'"
    );
    assert(
      !trendDictionary.data.phrases.includes("משתפרת"),
      "מילון המגמות לא מתלכלך משלוש האפשרויות הקבועות - רק ניסוחים חופשיים תחת 'אחר'"
    );

    const customRoleReport = await api(
      "POST",
      `/api/students/${sid}/reports`,
      { role_type: "פיזיותרפיה", note: "מפגש ראשון טוב", trend: "יציבה", notify_guardians: false },
      token
    );
    assert(customRoleReport.status === 201, "דיווח עם סוג דיווח בניסוח חופשי (לא ברשימת הקטגוריות הקבועות) התקבל");
    assert(
      customRoleReport.data.report.role_type === "פיזיותרפיה",
      "סוג הדיווח בניסוח החופשי נשמר כמו שהוא"
    );

    const roleDictionary = await api("GET", "/api/reports/dictionary?kind=role_type", null, token);
    assert(
      roleDictionary.status === 200 && roleDictionary.data.phrases.includes("פיזיותרפיה"),
      "מילון סוגי הדיווח כולל את הניסוח החופשי שהוזן תחת 'אחר'"
    );
    assert(
      !roleDictionary.data.phrases.includes("ריפוי בעיסוק"),
      "מילון סוגי הדיווח לא מתלכלך מהקטגוריות הקבועות - רק ניסוחים חופשיים תחת 'אחר'"
    );

    const missingRoleType = await api(
      "POST",
      `/api/students/${sid}/reports`,
      { role_type: "   ", note: "בדיקה", trend: "יציבה" },
      token
    );
    assert(missingRoleType.status === 400, "סוג דיווח ריק (גם רק רווחים) נדחה עם שגיאה ברורה");

    const myChildren = await api("GET", "/api/my-children", null, parentToken);
    assert(myChildren.status === 200 && myChildren.data.children.some(c => c.id === sid), "ההורה רואה את הילד שלו ברשימת /my-children");

    const parentSummary = await api("GET", `/api/students/${sid}/summary`, null, parentToken);
    assert(parentSummary.status === 200 && parentSummary.data.sessions_count === 2, "ההורה רואה סיכום עם מספר המפגשים הנכון");
    assert(parentSummary.data.reports.some(r => r.note === "התקדמות יפה"), "ההורה רואה את דוח ההתקדמות המקצועי בסיכום");
    assert(
      parentSummary.data.recent_sessions.some(s => s.note === "עבדנו על חיבור וחיסור, התקדמות יפה"),
      "ההורה רואה גם את דיווח המעקב החופשי שהחונך כתב על המפגש"
    );
    assert(
      parentSummary.data.lesson_reports.some(l => l.topic_studied === "גמ' השוכר את האומנין"),
      "ההורה רואה גם את טופס \"הכנה לשיעור\" בסיכום"
    );
    assert(parentSummary.data.documents === undefined, "מסמכים שהועלו לא נכללים בסיכום שההורה רואה (תוכן פנימי)");

    const parentTriesFile = await api("GET", `/api/students/${sid}/file`, null, parentToken);
    assert(parentTriesFile.status === 403, "ההורה נחסם מגישה לתיק המלא/הצ'אט הפנימי (403)");

    const parentTriesComment = await api("POST", `/api/students/${sid}/comments`, { text: "ניסיון כתיבה" }, parentToken);
    assert(parentTriesComment.status === 403, "ההורה נחסם מהוספת הערה לצ'אט הפנימי (403)");

    const parentTriesDocuments = await api("GET", `/api/students/${sid}/documents`, null, parentToken);
    assert(parentTriesDocuments.status === 403, "ההורה נחסם מרשימת המסמכים של התלמיד (403)");

    const parentTriesDocumentUpload = await api(
      "POST", `/api/students/${sid}/documents`, { title: "ניסיון", data_base64: "dGVzdA==" }, parentToken
    );
    assert(parentTriesDocumentUpload.status === 403, "ההורה נחסם מהעלאת מסמך לתיק התלמיד (403)");

    const strangerTriesSummary = await api("GET", `/api/students/${sid}/summary`, null, strangerToken);
    assert(strangerTriesSummary.status === 403, "משתמש זר (לא הורה ולא בעלים) נחסם מצפייה בסיכום");

    console.log("\n💳 תוכניות תרומה ומינוי (Cardcom - מצב MOCK)");
    const plans = await api("GET", "/api/plans");
    assert(plans.status === 200 && plans.data.plans.length === 2, "רשימת תוכניות ציבורית זמינה");
    const subscribe = await api("POST", "/api/subscribe", { planId: "basic" }, token);
    assert(subscribe.status === 201 && subscribe.data.mock === true, "הצטרפות לתוכנית יצרה הוראת קבע מדומה (MOCK)");

    console.log("\n📞 מנוע השיחה הקולית (IVR) — תפריט קטגוריות, ללא לחיצת מקשים, הכל בדיבור חופשי");
    const callSid = `TEST-${Date.now()}`;
    const greeting = await ivrCall(callSid, "+972500000001");
    assert(greeting.includes("<Gather") && greeting.includes("נא לציין"), "פתיחת שיחה מזהה משתמש ומציגה תפריט קטגוריות");
    assert(greeting.includes("שלום וברכה") && greeting.includes("הגעתם לקו הפנקס שלי"), "מיד כשמתקשרים (Twilio) המערכת פותחת בברכה 'שלום וברכה, הגעתם לקו הפנקס שלי' לפני שאר התפריט");

    await ivrSay(callSid, "הוצאה");
    const amountEcho = await ivrSay(callSid, "60");
    assert(amountEcho.includes("רשמתי 60 שקלים") && amountEcho.includes("לאיזו קטגוריה"), "מיד אחרי אמירת הסכום, המערכת חוזרת עליו ('רשמתי 60 שקלים') לפני ששואלת על הקטגוריה - כדי לתפוס מיד טעות זיהוי בסכום");
    await ivrSay(callSid, "תחבורה");
    const confirmXml = await ivrSay(callSid, "כן");
    assert(confirmXml.includes("נשמר"), "זרימת הוצאה קולית מלאה (קיצור ישיר מהתפריט הראשי) הושלמה ואושרה");

    const afterCallTx = await api("GET", "/api/transactions", null, token);
    const phoneTx = afterCallTx.data.transactions.find(t => t.source === "phone" && t.amount === 60);
    assert(!!phoneTx, "התנועה שנוצרה בשיחה הקולית אכן נשמרה במסד הנתונים עם source=phone");

    const balanceCallSid = `${callSid}-balance`;
    await ivrCall(balanceCallSid, "+972500000001");
    const balanceXml = await ivrSay(balanceCallSid, "ניהול חשבונות");
    assert(balanceXml.includes("היתרה הנוכחית שלך היא"), "קטגוריית 'ניהול חשבונות' מקריאה את היתרה");

    const txCallSid = `${callSid}-transactions`;
    await ivrCall(txCallSid, "+972500000001");
    const txMenu = await ivrSay(txCallSid, "תנועות");
    assert(txMenu.includes("הכנסה או הוצאה"), "קטגוריית 'תנועות' פותחת תת-תפריט הכנסה/הוצאה");
    await ivrSay(txCallSid, "הכנסה");
    const txIncomeConfirm = await ivrSay(txCallSid, "300");
    assert(txIncomeConfirm.includes("לאשר"), "תת-תפריט תנועות ממשיך לזרימת הכנסה הרגילה");
    await ivrSay(txCallSid, "כן");

    const therapistCallSid = `${callSid}-therapist`;
    await ivrCall(therapistCallSid, "+972500000001");
    const therapistMenu = await ivrSay(therapistCallSid, "מטפלים");
    assert(therapistMenu.includes("מה סוג הדיווח"), "קטגוריית 'מטפלים' פותחת את זרימת דיווח המטפל הקיימת");
    await ivrSay(therapistCallSid, "ריפוי בעיסוק");
    const therapistStudentEcho = await ivrSay(therapistCallSid, "תלמיד בדיקה");
    assert(
      therapistStudentEcho.includes("תלמיד בדיקה") && therapistStudentEcho.includes("מה תוכן הדיווח"),
      "מיד אחרי זיהוי שם התלמיד בדיווח מטפל, המערכת חוזרת על השם לפני ששואלת על תוכן הדיווח"
    );

    const supervisorCallSid = `${callSid}-supervisor`;
    await ivrCall(supervisorCallSid, "+972500000001");
    await ivrSay(supervisorCallSid, "הערת מפקח");
    const supervisorStudentEcho = await ivrSay(supervisorCallSid, "תלמיד בדיקה");
    assert(
      supervisorStudentEcho.includes("תלמיד בדיקה") && supervisorStudentEcho.includes("מה תוכן ההערה"),
      "מיד אחרי זיהוי שם התלמיד בהערת מפקח, המערכת חוזרת על השם לפני ששואלת על תוכן ההערה"
    );

    console.log("\n👨‍👩‍👧 קטגוריית 'הורה' בטלפון — סיכום קולי על הילד, בלי גישה לאתר");
    await api("PUT", "/api/me", { phone: "+972500000055" }, parentToken); // נותנים להורה מספר טלפון קבוע לזיהוי בשיחה
    const guardianCallSid = `${callSid}-guardian`;
    await ivrCall(guardianCallSid, "+972500000055");
    const guardianSummaryXml = await ivrSay(guardianCallSid, "הורה");
    assert(
      guardianSummaryXml.includes("תלמיד בדיקה") && guardianSummaryXml.includes("2 מפגשים"),
      "הורה משויך שומע בקול סיכום נכון (שם הילד ומספר המפגשים) על הילד היחיד שלו"
    );

    const noChildCallSid = `${callSid}-nochild`;
    await ivrCall(noChildCallSid, "+972500000001"); // המשתמש הראשי (חונך) הוא לא הורה של אף אחד
    const noChildXml = await ivrSay(noChildCallSid, "הורה");
    assert(noChildXml.includes("לא נמצאו ילדים"), "משתמש שאינו הורה של אף תלמיד מקבל תשובה ברורה בקטגוריית 'הורה'");

    console.log("\n📝 הרשמה ישירות בטלפון (Twilio) — מספר לא מזוהה יכול להירשם בלי לגשת לאתר");
    const signupCallSid = `${callSid}-signup`;
    const signupPhone = "+972500000077";
    const signupGreeting = await ivrCall(signupCallSid, signupPhone);
    assert(
      signupGreeting.includes("אינו מזוהה") && signupGreeting.includes("<Gather") && signupGreeting.includes("השם המלא"),
      "מספר לא מזוהה מקבל הצעה להירשם בטלפון (לא ננתק מיד)"
    );
    assert(signupGreeting.includes("שלום וברכה") && signupGreeting.includes("הגעתם לקו הפנקס שלי"), "גם למספר לא מזוהה, הברכה 'שלום וברכה, הגעתם לקו הפנקס שלי' נאמרת מיד בתחילת השיחה");
    const signupConfirmXml = await ivrSay(signupCallSid, "רותם כהן");
    assert(signupConfirmXml.includes("רותם כהן") && signupConfirmXml.includes("לאשר"), "שם שנאמר חוזר לאישור לפני יצירת המשתמש");

    // תיקון בטיחות: קלט לא ברור באישור השם לא מוחק בשקט את השם ומתחיל את ההרשמה מחדש - הוא רק
    // חוזר על אותה שאלת אישור, עם השם שכבר נאמר עדיין שמור (בדיוק כמו התיקון שכבר קיים בכל שאר
    // צמתי האישור - expense_confirm וכו').
    const signupUnclearXml = await ivrSay(signupCallSid, "אולי אחר כך");
    assert(
      signupUnclearXml.includes("רותם כהן") && signupUnclearXml.includes("לאשר") && !signupUnclearXml.includes("מה השם המלא שלכם"),
      "קלט לא ברור באישור השם בהרשמה חוזר על אותה שאלת אישור (עם השם שכבר נאמר), ולא מתחיל את ההרשמה מחדש בשקט"
    );

    const signupPinPrompt = await ivrSay(signupCallSid, "כן");
    assert(
      signupPinPrompt.includes("קוד סודי") && signupPinPrompt.includes('input="dtmf"') && signupPinPrompt.includes('numDigits="4"'),
      "אחרי אישור השם, המערכת מבקשת קוד PIN בן 4 ספרות בהקשה (DTMF) - לא בדיבור"
    );

    // תיקון בטיחות: קוד PIN שלא תואם באישור החוזר לא נשמר בשקט - חוזרים להתחיל את הגדרת ה-PIN מחדש
    // (משתמשים כאן ב-ivrTapDigits, לא ivrSay, כדי לבדוק בפועל את שדה "Digits" האמיתי של Twilio)
    const signupPinConfirmPrompt = await ivrTapDigits(signupCallSid, "1234");
    assert(signupPinConfirmPrompt.includes("שוב") && signupPinConfirmPrompt.includes('input="dtmf"'), "אחרי הקשת 4 ספרות, מתבקשים להקיש אותן שוב לאישור (גם בהקשה, לא בדיבור)");
    assert(
      signupPinConfirmPrompt.includes("התקבל"),
      "המענה אחרי הקשת ה-PIN הראשונה פותח ב'התקבל' - כדי שהמתקשר ידע בבירור שההקשה נקלטה, גם אם יש עיכוב רשת עד שהתשובה מגיעה"
    );
    const signupPinMismatchPrompt = await ivrSay(signupCallSid, "9999");
    assert(
      signupPinMismatchPrompt.includes("לא תאמו") && signupPinMismatchPrompt.includes('input="dtmf"'),
      "אם הספרות באישור לא תואמות למה שהוקש קודם, מתבקשים להתחיל את הגדרת ה-PIN מחדש (לא נשמר קוד שגוי בטעות)"
    );
    await ivrSay(signupCallSid, "1234");
    const signupEmailPrompt = await ivrSay(signupCallSid, "1234");
    assert(
      signupEmailPrompt.includes("הוגדר בהצלחה") && signupEmailPrompt.includes("כתובת מייל") && signupEmailPrompt.includes("<Gather"),
      "אחרי הקשה כפולה תואמת של קוד ה-PIN, המערכת שואלת (לא חובה) על כתובת מייל לפני יצירת המשתמש, עם אישור ברור שהקוד הוגדר"
    );
    const signupDoneXml = await ivrSay(signupCallSid, "דלג");
    assert(signupDoneXml.includes("נרשמת בהצלחה") && signupDoneXml.includes("נא לציין"), "אמירת 'דלג' על שלב המייל עדיין יוצרת את המשתמש ועובר ישר לתפריט הקטגוריות הרגיל");

    const signupPinLogin = await api("POST", "/api/auth/login", { username: `phone_${signupPhone.replace(/\D/g, "").slice(-9)}`, password: "1234" });
    assert(signupPinLogin.status === 200 && signupPinLogin.data.token, "קוד ה-PIN שהוקש בטלפון בהרשמה עובד גם כסיסמה להתחברות באתר");

    const secondCallSameNumber = await ivrCall(`${signupCallSid}-again`, signupPhone);
    assert(
      secondCallSameNumber.includes("רותם כהן") && !secondCallSameNumber.includes("אינו מזוהה"),
      "שיחה חוזרת מאותו מספר אחרי ההרשמה כבר מזהה את המשתמש (בלי הצעת הרשמה נוספת)"
    );

    console.log("\n📧 הרשמה בטלפון עם כתובת מייל אופציונלית שנאמרה בקול");
    const emailSignupCallSid = `${callSid}-signup-email`;
    const emailSignupPhone = "+972500000078";
    await ivrCall(emailSignupCallSid, emailSignupPhone);
    await ivrSay(emailSignupCallSid, "גל שני");
    await ivrSay(emailSignupCallSid, "כן");
    await ivrSay(emailSignupCallSid, "5678");
    await ivrSay(emailSignupCallSid, "5678");
    const emailDoneXml = await ivrSay(emailSignupCallSid, "gal כרוכית gmail נקודה com");
    assert(
      emailDoneXml.includes("נרשמת בהצלחה") && emailDoneXml.includes("gal@gmail.com"),
      "כתובת מייל שנאמרה בקול (עם 'כרוכית'/'נקודה' במקום @ ונקודה) מזוהה ונשמרת אצל המשתמש החדש, אחרי הגדרת קוד PIN"
    );

    console.log("\n☎️ מנוע השיחה הקולית מול ימות המשיח (שלוחת API) — אותה מכונת מצבים, פרוטוקול שונה");
    const ymCallId = `YM-${Date.now()}`;
    const ymGreeting = await yemotCall({ callId: ymCallId, phone: "0500000001" });
    assert(ymGreeting.startsWith("read=t-") && ymGreeting.includes("נא לציין"), "פתיחת שיחה בימות (מספר בפורמט מקומי) מזהה משתמש ומציגה תפריט קטגוריות");
    assert(ymGreeting.includes("שלום וברכה") && ymGreeting.includes("הגעתם לקו הפנקס שלי"), "מיד כשמתקשרים גם בימות המערכת פותחת בברכה 'שלום וברכה, הגעתם לקו הפנקס שלי' לפני שאר התפריט");
    assert(
      ymGreeting.includes("1 עד 6") && !ymGreeting.includes("סולמית"),
      "כבר בברכת הפתיחה בימות מוזכר שאפשר להקיש ספרה (1-6) בלי לחכות, במקום לדבר - בקצרה, כדי לא להאריך את זמן ההשמעה. " +
        "לא מוזכרת כאן סולמית - בתפריט הראשי (בחירת קטגוריה) אין לה שום פעולה, וזה בעבר גרם למתקשרים לנסות להקיש אותה בלי שקרה כלום"
    );

    const ymUnknown = await yemotCall({ callId: `${ymCallId}-unknown`, phone: "0500000099" });
    assert(
      ymUnknown.includes("אינו מזוהה") && ymUnknown.startsWith("read=t-") && ymUnknown.includes("השם המלא"),
      "שיחת ימות ממספר לא רשום מקבלת הצעת הרשמה בטלפון (לא מנותקת מיד)"
    );
    assert(ymUnknown.includes("שלום וברכה") && ymUnknown.includes("הגעתם לקו הפנקס שלי"), "גם בימות, למספר לא מזוהה, הברכה נאמרת מיד בתחילת השיחה");

    await yemotCall({ callId: ymCallId, speech: "הוצאה" });
    await yemotCall({ callId: ymCallId, speech: "45" });
    await yemotCall({ callId: ymCallId, speech: "מזון" });
    const ymConfirm = await yemotCall({ callId: ymCallId, speech: "כן" });
    assert(ymConfirm.includes("נשמר") && ymConfirm.includes("id_list_message=") && ymConfirm.includes("g-hangup"), "זרימת הוצאה קולית מלאה דרך ימות הושלמה ואושרה, ומחזירה פקודת ניתוק תקינה");

    const afterYmTx = await api("GET", "/api/transactions", null, token);
    const ymTx = afterYmTx.data.transactions.find(t => t.source === "phone" && t.amount === 45 && t.category === "מזון");
    assert(!!ymTx, "התנועה שנוצרה בשיחת ימות אכן נשמרה במסד הנתונים עם source=phone");

    console.log("\n❓ קלט לא ברור בשאלת אישור לא מבטל בשקט (רק 'לא' מפורש מבטל) - כדי לא לאבד תנועה שהוזנה");
    // בבדיקה בפועל מול ימות התברר שמילים כמו "אישור"/"לאשר" לפעמים לא מזוהות בדיוק ע"י זיהוי הדיבור.
    // בעבר כל קלט שלא זוהה כ"כן" נחשב אוטומטית "לא" וביטל את כל התנועה בשקט - התנהגות מסוכנת.
    const ymUnclearCallId = `${ymCallId}-unclear-confirm`;
    await yemotCall({ callId: ymUnclearCallId, phone: "0500000001" });
    await yemotCall({ callId: ymUnclearCallId, speech: "הוצאה" });
    await yemotCall({ callId: ymUnclearCallId, speech: "63" });
    await yemotCall({ callId: ymUnclearCallId, speech: "מזון" });
    const ymUnclearRetry = await yemotCall({ callId: ymUnclearCallId, speech: "משהו אחר לגמרי" });
    assert(
      ymUnclearRetry.includes("לא הבנתי") && ymUnclearRetry.includes("63") && ymUnclearRetry.startsWith("read=t-"),
      "קלט לא ברור (לא 'כן' ולא 'לא' מפורש) בשאלת אישור חוזר על אותה שאלת אישור, ולא מבטל ולא שומר"
    );
    const afterUnclear = await api("GET", "/api/transactions", null, token);
    assert(
      !afterUnclear.data.transactions.some(t => t.source === "phone" && t.amount === 63),
      "התנועה עדיין לא נשמרה אחרי קלט לא ברור - רק אחרי אישור בפועל"
    );
    const ymUnclearThenYes = await yemotCall({ callId: ymUnclearCallId, speech: "כן" });
    assert(ymUnclearThenYes.includes("נשמר") && ymUnclearThenYes.includes("g-hangup"), "אחרי הקלט הלא ברור, אמירת 'כן' עדיין שומרת את התנועה כרגיל");
    const afterUnclearYes = await api("GET", "/api/transactions", null, token);
    assert(
      afterUnclearYes.data.transactions.some(t => t.source === "phone" && t.amount === 63 && t.category === "מזון"),
      "התנועה נשמרה בסוף עם הסכום/קטגוריה הנכונים, אחרי שהמשתמש קיבל הזדמנות שנייה"
    );

    console.log("\n#️⃣ אישור מהיר בהקשה (1) בערוץ ימות - בלי לחכות לזיהוי הדיבור על 'כן'");
    // הערה: בעבר הוצעה כאן סולמית בודדת כקיצור אישור, אבל בבדיקה בפועל מול ימות התברר שסולמית בודדת
    // (בלי ספרה לפניה) לרוב לא מגיעה בכלל לשרת במצב זיהוי דיבור - כנראה נבלעת כתו סיום קלט. עברנו
    // להקשת 1, שכבר מוכחת כעובדת באמינות בכל שאר התפריטים. עדיין מקבלים גם סולמית בפועל (ר' isConfirmYes)
    // ליתר בטחון, אבל זה לא מה שמוצע/מובטח למתקשר יותר.
    const ymDigitCallId = `${ymCallId}-digit-confirm`;
    await yemotCall({ callId: ymDigitCallId, phone: "0500000001" });
    await yemotCall({ callId: ymDigitCallId, speech: "הכנסה" });
    const ymDigitConfirmPrompt = await yemotCall({ callId: ymDigitCallId, speech: "77" });
    assert(ymDigitConfirmPrompt.includes("1 לאישור"), "שאלת האישור בימות מזכירה אפשרות הקשת 1 לאישור מהיר");
    const ymDigitConfirmDone = await yemotCall({ callId: ymDigitCallId, speech: "1" });
    assert(
      ymDigitConfirmDone.includes("נשמר") && ymDigitConfirmDone.includes("g-hangup"),
      "הקשת 1 בלבד, בלי לומר 'כן', נחשבת אישור תקף ושומרת את התנועה"
    );
    const afterDigitTx = await api("GET", "/api/transactions", null, token);
    assert(
      afterDigitTx.data.transactions.some(t => t.source === "phone" && t.amount === 77 && t.type === "income"),
      "התנועה שאושרה בהקשת 1 אכן נשמרה במסד הנתונים"
    );

    const ymHashConfirmCallId = `${ymCallId}-hash-confirm`;
    await yemotCall({ callId: ymHashConfirmCallId, phone: "0500000001" });
    await yemotCall({ callId: ymHashConfirmCallId, speech: "הכנסה" });
    await yemotCall({ callId: ymHashConfirmCallId, speech: "88" });
    const ymHashConfirmDone = await yemotCall({ callId: ymHashConfirmCallId, speech: "#" });
    assert(
      ymHashConfirmDone.includes("נשמר") && ymHashConfirmDone.includes("g-hangup"),
      "סולמית בודדת עדיין מתקבלת כאישור תקף אם היא כן מגיעה לשרת (גיבוי נוסף, גם אם לא מוצע יותר למתקשר)"
    );

    const ymBalanceCallId = `${ymCallId}-balance`;
    await yemotCall({ callId: ymBalanceCallId, phone: "+972500000001" }); // מוודאים שפורמט בינלאומי (+972) גם מזוהה
    const ymBalance = await yemotCall({ callId: ymBalanceCallId, speech: "חשבונות" });
    assert(ymBalance.includes("היתרה הנוכחית שלך היא"), "קטגוריית 'ניהול חשבונות' (מילה 'חשבונות') עובדת גם דרך ימות");

    console.log("\n#️⃣ קיצורי הקשה (DTMF) בתפריט - במקום לדבר, ובלי לחכות שהמערכת תסיים להקריא");
    const ymDigitMenuCallId = `${ymCallId}-digit-menu`;
    await yemotCall({ callId: ymDigitMenuCallId, phone: "0500000001" });
    const ymDigitBalance = await yemotCall({ callId: ymDigitMenuCallId, speech: "1" }); // 1 = ניהול חשבונות
    assert(ymDigitBalance.includes("היתרה הנוכחית שלך היא"), "הקשת 1 בתפריט הראשי שקולה לאמירת 'ניהול חשבונות'");

    const ymDigitTxCallId = `${ymCallId}-digit-tx`;
    await yemotCall({ callId: ymDigitTxCallId, phone: "0500000001" });
    const ymDigitTxType = await yemotCall({ callId: ymDigitTxCallId, speech: "2" }); // 2 = תנועות
    assert(ymDigitTxType.includes("הכנסה או הוצאה") && ymDigitTxType.includes("1 להכנסה"), "הקשת 2 בתפריט הראשי שקולה לאמירת 'תנועות', ומזכירה גם קיצורי הקשה לשלב הבא");
    const ymDigitIncome = await yemotCall({ callId: ymDigitTxCallId, speech: "1" }); // 1 = הכנסה
    assert(ymDigitIncome.includes("מה סכום ההכנסה"), "הקשת 1 בבחירת סוג תנועה שקולה לאמירת 'הכנסה'");
    await yemotCall({ callId: ymDigitTxCallId, speech: "500" });
    const ymDigitIncomeConfirm = await yemotCall({ callId: ymDigitTxCallId, speech: "#" });
    assert(ymDigitIncomeConfirm.includes("נשמר") && ymDigitIncomeConfirm.includes("g-hangup"), "זרימה מלאה של תנועה דרך הקשות בלבד (בלי מילה אחת בדיבור) עובדת עד הסוף");

    const ymDigitMentorCallId = `${ymCallId}-digit-mentor`;
    await yemotCall({ callId: ymDigitMentorCallId, phone: "0500000001" });
    await yemotCall({ callId: ymDigitMentorCallId, speech: "3" }); // 3 = חונכות
    const ymDigitMentorAction = await yemotCall({ callId: ymDigitMentorCallId, speech: "תלמיד בדיקה" });
    assert(ymDigitMentorAction.includes("1 לכניסה") && ymDigitMentorAction.includes("2 ליציאה"), "אחרי זיהוי תלמיד, מוזכרים גם קיצורי הקשה לכניסה/יציאה/מפגש רגיל");

    console.log("\n➕ חונכות: הוספת תלמיד חדש ישירות מהטלפון (בלי לגשת לאתר), אם השם לא נמצא ברשימת החונך");
    const ymAddStudentCallId = `${ymCallId}-add-student`;
    await yemotCall({ callId: ymAddStudentCallId, phone: "0500000001" });
    await yemotCall({ callId: ymAddStudentCallId, speech: "חונכות" });
    const ymAddStudentOffer = await yemotCall({ callId: ymAddStudentCallId, speech: "משה ישראלי" });
    assert(
      ymAddStudentOffer.includes("לא מצאתי תלמיד בשם משה ישראלי") && ymAddStudentOffer.includes("להוסיף אותו כתלמיד חדש"),
      "שם תלמיד שלא נמצא ברשימת החונך מקבל הצעה להוסיף אותו כתלמיד חדש, ולא רק 'לא מצאתי, נסו שוב'"
    );
    const ymAddStudentDone = await yemotCall({ callId: ymAddStudentCallId, speech: "1" }); // 1 = כן, להוסיף
    assert(
      ymAddStudentDone.includes("נוסף תלמיד חדש") && ymAddStudentDone.includes("משה ישראלי") && ymAddStudentDone.includes("1 לכניסה"),
      "הקשת/אמירת אישור יוצרת בפועל תלמיד חדש (owner=החונך המתקשר) וממשיכה ישר לבחירת סוג הפעולה"
    );
    const studentsAfterAdd = await api("GET", "/api/students", null, token);
    const addedStudent = studentsAfterAdd.data.students.find(s => s.name === "משה ישראלי");
    assert(!!addedStudent, "התלמיד החדש שנוסף בטלפון אכן נשמר במסד הנתונים תחת החונך הנכון");

    console.log("\n➖ חונכות: הסרת תלמיד (מחיקה רכה, active=0) - גם מהטלפון וגם מהאתר");
    const ymRemoveCallId = `${ymCallId}-remove-student`;
    await yemotCall({ callId: ymRemoveCallId, phone: "0500000001" });
    await yemotCall({ callId: ymRemoveCallId, speech: "חונכות" });
    await yemotCall({ callId: ymRemoveCallId, speech: "משה ישראלי" });
    const ymRemoveConfirmPrompt = await yemotCall({ callId: ymRemoveCallId, speech: "4" }); // 4 = הסרת התלמיד
    assert(ymRemoveConfirmPrompt.includes("לאשר") && ymRemoveConfirmPrompt.includes("להסיר את משה ישראלי"), "הקשת 4 בשלב הפעולה מציעה לאשר הסרת התלמיד, ולא מסירה מיד בלי אישור");
    const ymRemoveDone = await yemotCall({ callId: ymRemoveCallId, speech: "כן" });
    assert(ymRemoveDone.includes("הוסר") && ymRemoveDone.includes("g-hangup"), "אישור ההסרה מסתיים בניתוק תקין עם הודעת אישור");
    const studentsAfterRemove = await api("GET", "/api/students", null, token);
    assert(!studentsAfterRemove.data.students.some(s => s.name === "משה ישראלי"), "אחרי ההסרה, התלמיד כבר לא מופיע ברשימת התלמידים הפעילים (/api/students)");

    const removeViaWeb = await api("DELETE", `/api/students/${addedStudent.id}`, null, token);
    assert(removeViaWeb.status === 404 || removeViaWeb.status === 200, "אותו נתיב הסרה (DELETE /api/students/:id) זמין גם לאתר - אידמפוטנטי, לא קורס גם אם כבר הוסר");

    const foreignStudent = await api("POST", "/api/students", { name: "תלמיד של מישהו אחר" }, parentToken);
    const foreignRemoveAttempt = await api("DELETE", `/api/students/${foreignStudent.data.student.id}`, null, token);
    assert(foreignRemoveAttempt.status === 404, "משתמש לא יכול להסיר תלמיד שאינו הבעלים שלו (404, לא חושף מידע)");

    console.log("\n📝 הרשמה ישירות בטלפון (ימות המשיח) — אותה יכולת גם דרך ימות");
    const ymSignupCallId = `${ymCallId}-signup`;
    const ymSignupPhone = "0500000088";
    const ymSignupGreeting = await yemotCall({ callId: ymSignupCallId, phone: ymSignupPhone });
    assert(ymSignupGreeting.includes("אינו מזוהה") && ymSignupGreeting.includes("השם המלא"), "מספר לא מזוהה בימות מקבל הצעת הרשמה");
    await yemotCall({ callId: ymSignupCallId, speech: "דנה לוי" });
    const ymSignupPinPrompt = await yemotCall({ callId: ymSignupCallId, speech: "כן" });
    assert(
      ymSignupPinPrompt.includes("קוד סודי") && ymSignupPinPrompt.includes(",no,4,4,7,"),
      "גם בימות, אחרי אישור השם מתבקש קוד PIN בן 4 ספרות בהקשה (מצב tap - max_digits/min_digits=4, sec_wait=7)"
    );
    const ymSignupPinConfirmPrompt = await yemotCall({ callId: ymSignupCallId, speech: "4321" });
    assert(
      ymSignupPinConfirmPrompt.includes("התקבל") && ymSignupPinConfirmPrompt.includes("שוב"),
      "אחרי הקשת 4 הספרות הראשונות, המענה פותח ב'התקבל' - כדי שהמתקשר ידע בבירור שההקשה נקלטה, גם עם עיכוב הרשת"
    );
    const ymSignupEmailPrompt = await yemotCall({ callId: ymSignupCallId, speech: "4321" });
    assert(
      ymSignupEmailPrompt.includes("הוגדר בהצלחה") && ymSignupEmailPrompt.includes("כתובת מייל"),
      "גם בימות, אחרי הקשה כפולה תואמת של קוד ה-PIN שואלים (לא חובה) על כתובת מייל, עם אישור ברור שהקוד הוגדר"
    );
    const ymSignupDone = await yemotCall({ callId: ymSignupCallId, speech: "דלג" });
    assert(ymSignupDone.includes("נרשמת בהצלחה") && ymSignupDone.includes("דנה לוי"), "הרשמה טלפונית דרך ימות יוצרת משתמש ועוברת לתפריט הרגיל, גם כשמדלגים על המייל");

    const ymSignupPinLogin = await api("POST", "/api/auth/login", { username: `phone_${ymSignupPhone.replace(/\D/g, "").slice(-9)}`, password: "4321" });
    assert(ymSignupPinLogin.status === 200 && ymSignupPinLogin.data.token, "קוד ה-PIN שהוקש בימות עובד גם כסיסמה להתחברות באתר");

    const ymSecondCall = await yemotCall({ callId: `${ymSignupCallId}-again`, phone: ymSignupPhone });
    assert(
      ymSecondCall.includes("דנה לוי") && !ymSecondCall.includes("אינו מזוהה"),
      "שיחת ימות חוזרת מאותו מספר אחרי ההרשמה כבר מזהה את המשתמש שנוצר"
    );

    console.log("\n🎙️ זיהוי דיבור משודרג (ימות + Whisper) — במצב MOCK (בלי מפתחות) נשאר שקוף לחלוטין");
    const speechToText = require("../src/services/speechToText");
    assert(
      speechToText.isConfigured() === false,
      "isConfigured() מחזיר false כל עוד YEMOT_API_TOKEN/YEMOT_EXTENSION_NUMBER/OPENAI_API_KEY לא מוגדרים יחד (מצב הבדיקות)"
    );
    const whisperMockResult = await speechToText.downloadAndTranscribe("some-call-id");
    assert(whisperMockResult === null, "downloadAndTranscribe() מחזיר null במצב MOCK, בלי לנסות פנייה רשתית כלשהי");
    assert(
      ymSignupGreeting.includes(",no,voice,") && !ymSignupGreeting.includes(",no,record,"),
      "כשלא מוגדר זיהוי דיבור משודרג, שלב טקסט חופשי בימות (שם בהרשמה) עדיין משתמש במנוע ה-STT הרגיל של ימות ולא במצב הקלטה גולמית"
    );

  } catch (err) {
    failed++;
    console.error("❌ שגיאה בלתי צפויה בבדיקות:", err);
  } finally {
    // מחכים שהשרת באמת ייסגר לפני מחיקת קובץ מסד הנתונים - בווינדוס הקובץ
    // עלול להישאר "נעול" לרגע אחרי kill(), מה שגורם לשגיאת EBUSY במחיקה מיידית.
    await new Promise((resolve) => {
      server.once("exit", resolve);
      server.kill();
      setTimeout(resolve, 2000); // גיבוי - ממשיכים גם אם האירוע לא הגיע
    });
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        if (fs.existsSync(TEST_DB + suffix)) fs.unlinkSync(TEST_DB + suffix);
      } catch (e) {
        // לא קריטי - קובץ זמני שיימחק בהרצה הבאה בכל מקרה
        console.log(`  (הערה: לא ניתן היה למחוק קובץ זמני ${suffix || ""} - לא משפיע על תוצאות הבדיקה)`);
      }
    }
    try {
      if (fs.existsSync(TEST_UPLOADS_DIR)) fs.rmSync(TEST_UPLOADS_DIR, { recursive: true, force: true });
    } catch (e) {
      console.log("  (הערה: לא ניתן היה למחוק את תיקיית הקבצים הזמנית של הבדיקה - לא משפיע על תוצאות הבדיקה)");
    }
  }

  console.log(`\n---\nעברו: ${passed} | נכשלו: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
