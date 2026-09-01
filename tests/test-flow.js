// test-flow.js — בדיקה אוטומטית מקצה לקצה. מריצה שרת אמיתי על פורט זמני, מבצעת קריאות HTTP
// אמיתיות (בלי שום ספרייה חיצונית, רק fetch גלובלי), ובודקת שכל הזרימות המרכזיות עובדות.
// הרצה: npm test  (או: node tests/test-flow.js)
"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { buildTestXlsx } = require("./helpers/buildTestXlsx");
const { buildTestPdf } = require("./helpers/buildTestPdf");

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
    env: {
      ...process.env,
      PORT: String(TEST_PORT), DB_PATH: TEST_DB, UPLOADS_DIR: TEST_UPLOADS_DIR, RECOVERY_MOCK: "true", CARDCOM_MOCK: "true",
      // מוגדר כאן כדי לבדוק את תכונת "מנהל מערכת" (ר' routes/systemAdmin.js) - סיסמת בדיקה קבועה,
      // לא סיסמה אמיתית מהייצור.
      SYSTEM_ADMIN_PASSWORD: "test-system-admin-password-9427",
    },
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
      full_name: "סיסמה לא תקינה", username: `badpw_${Date.now()}`, password: "abc123", phone: "+972500000090",
    });
    assert(badFormatSignup.status === 400, "הרשמה באתר עם סיסמה שאינה בדיוק 4 ספרות נדחית");
    const shortFormatSignup = await api("POST", "/api/auth/signup", {
      full_name: "סיסמה קצרה מדי", username: `shortpw_${Date.now()}`, password: "123", phone: "+972500000091",
    });
    assert(shortFormatSignup.status === 400, "הרשמה באתר עם סיסמה קצרה מ-4 ספרות נדחית");

    console.log("\n📱 טלפון חובה בהרשמה באתר (משוב אמיתי: בלי זה אין ערוץ זיהוי בשיחה נכנסת/כניסה בטלפון)");
    const noPhoneAtAllSignup = await api("POST", "/api/auth/signup", {
      full_name: "בלי טלפון בכלל", username: `no_phone_at_all_${Date.now()}`, password: "1234",
    });
    assert(noPhoneAtAllSignup.status === 400, "הרשמה באתר בלי מספר טלפון בכלל נדחית");

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
    await ivrSay(phoneOnlyCallSid, "2222");
    await ivrSay(phoneOnlyCallSid, "2222");
    await ivrSay(phoneOnlyCallSid, "לא");
    const phoneOnlyUsername = `phone_${phoneOnlyPhone.replace(/\D/g, "").slice(-9)}`;

    // תיקון UX חשוב: מי שנרשם בטלפון מקבל שם משתמש אוטומטי (phone_XXXXXXXXX) שאף פעם לא נאמר לו
    // בקול - בלי האפשרות להתחבר גם עם מספר הטלפון עצמו, אין לו שום דרך לדעת מה להקליד באתר (ר'
    // findUserByLoginIdentifier ב-routes/auth.js). בודקים כאן שהתחברות עם מספר הטלפון (במקום שם
    // המשתמש) עובדת - עם קוד ה-PIN שהוגדר כבר בהרשמה הטלפונית עצמה (2222), לפני כל שחזור סיסמה.
    const phoneNumberLogin = await api("POST", "/api/auth/login", { username: phoneOnlyPhone, password: "2222" });
    assert(
      phoneNumberLogin.status === 200 && phoneNumberLogin.data.token,
      "התחברות באתר עם מספר הטלפון עצמו (במקום שם המשתמש האוטומטי) וקוד ה-PIN שהוגדר בטלפון - עובדת"
    );

    const phoneOnlyResetReq = await api("POST", "/api/auth/forgot-password/request", { username: phoneOnlyPhone, channel: "phone" });
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

    // תוקן (טלפון חובה בהרשמה, ר' למעלה): "משתמש בלי טלפון" כבר לא בר-השגה דרך הרשמה רגילה באתר -
    // המשתמש הזה עדיין שימושי לבדיקת "בלי כתובת מייל רשומה" (יש לו טלפון, אין לו מייל).
    const noEmailSignup = await api("POST", "/api/auth/signup", {
      full_name: "בלי מייל", username: `no_email_${Date.now()}`, password: "1234", phone: "+972500000092",
    });
    const noPhoneClaimAttempt = await api("POST", "/api/me/request-admin-claim", { channel: "email" }, noEmailSignup.data.token);
    assert(noPhoneClaimAttempt.status === 400, "משתמש בלי כתובת מייל רשומה לא יכול לתבוע בעל הקו בערוץ מייל (אין ערוץ לאמת אותו)");

    // ערוץ מייל לתביעת בעל הקו (נוסף בעקבות בקשת פיצ'ר - "למה לא לעשות שליחה גם למייל בינתיים").
    const emailClaimSignup = await api("POST", "/api/auth/signup", {
      full_name: "תובע דרך מייל", username: `email_claim_${Date.now()}`, password: "1234", email: "emailclaim@example.com", phone: "+972500000093",
    });
    const emailClaimNoEmailUser = await api("POST", "/api/me/request-admin-claim", { channel: "email" }, noEmailSignup.data.token);
    assert(emailClaimNoEmailUser.status === 400, "משתמש בלי כתובת מייל רשומה לא יכול לתבוע בעל הקו בערוץ מייל");
    const emailClaimReq = await api("POST", "/api/me/request-admin-claim", { channel: "email" }, emailClaimSignup.data.token);
    assert(
      emailClaimReq.status === 200 && emailClaimReq.data.demoCode && emailClaimReq.data.message.includes("מייל"),
      "תביעת בעל הקו בערוץ מייל עובדת (יש למשתמש הזה גם טלפון וגם מייל רשומים)"
    );

    const wrongClaimCode = await api("POST", "/api/me/request-admin-claim", {}, token);
    assert(wrongClaimCode.status === 200 && wrongClaimCode.data.demoCode, "בקשת תביעת בעל הקו שולחת קוד אישור בשיחה קולית (demoCode במצב MOCK)");
    const wrongClaimConfirm = await api("POST", "/api/me/confirm-admin-claim", { code: "0000" }, token);
    assert(wrongClaimConfirm.status === 400, "קוד שגוי לא מאשר תביעת בעל הקו");
    const rightClaimConfirm = await api("POST", "/api/me/confirm-admin-claim", { code: wrongClaimCode.data.demoCode }, token);
    assert(
      rightClaimConfirm.status === 200 && rightClaimConfirm.data.user.roles.includes("admin"),
      "קוד נכון מאשר את התביעה בפועל - המשתמש (שנרשם באתר עם טלפון משלו) הופך ל'בעל הקו'"
    );

    const secondClaimAttempt = await api("POST", "/api/me/request-admin-claim", {}, noEmailSignup.data.token);
    assert(secondClaimAttempt.status === 409, "אחרי שכבר יש בעל קו, אף אחד אחר לא יכול לתבוע את התפקיד (409)");

    console.log("\n👑 תפקיד 'מפקח' - לא ניתן להצהרה עצמית, רק דרך אישור בעל הקו");
    const supervisorViaSignup = await api("POST", "/api/auth/signup", {
      full_name: "מנסה להיות מפקח בהרשמה", username: `sneaky_signup_${Date.now()}`, password: "1234", roles: "mentor,supervisor", phone: "+972500000094",
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

    console.log("\n🔑 'מנהל מערכת' - כפתור להענקת/הסרת מפקח ישירות, מוגן בסיסמה מיוחדת (בלי תהליך הקוד מול בעל הקו)");
    const smWrongPassword = await api("POST", "/api/system-admin/search-users", { password: "לא-נכון", query: "בדיקה" });
    assert(smWrongPassword.status === 403, "סיסמת מנהל מערכת שגויה נדחית (403), לא חושפת אם התכונה בכלל מוגדרת");

    const smNoPassword = await api("POST", "/api/system-admin/grant-supervisor", { user_id: 1 });
    assert(smNoPassword.status === 403, "בלי סיסמה בכלל - נדחה גם כן (403), לא 200/500");

    const smSearch = await api("POST", "/api/system-admin/search-users", { password: "test-system-admin-password-9427", query: "בדיקה אוטומטית" });
    assert(
      smSearch.status === 200 && smSearch.data.users.some(u => u.username && u.full_name === "בדיקה אוטומטית"),
      "עם הסיסמה הנכונה, חיפוש לפי שם מוצא את המשתמש (החונך הראשי של הבדיקות)"
    );
    const smTargetUser = smSearch.data.users.find(u => u.full_name === "בדיקה אוטומטית");
    assert(!(smTargetUser.roles || "").split(",").includes("supervisor"), "המשתמש שנמצא עדיין לא מפקח, לפני ההענקה");

    const smGrant = await api("POST", "/api/system-admin/grant-supervisor", { password: "test-system-admin-password-9427", user_id: smTargetUser.id });
    assert(
      smGrant.status === 200 && smGrant.data.user.roles.split(",").includes("supervisor"),
      "הענקת מפקח ישירות (בלי קוד, בלי בעל קו) עובדת מיד עם הסיסמה הנכונה"
    );
    const smSearchAfterGrant = await api("POST", "/api/system-admin/search-users", { password: "test-system-admin-password-9427", query: "בדיקה אוטומטית" });
    const smTargetAfterGrant = smSearchAfterGrant.data.users.find(u => u.id === smTargetUser.id);
    assert((smTargetAfterGrant.roles || "").split(",").includes("supervisor"), "ההענקה נשמרה בפועל במסד הנתונים - נראית גם בחיפוש הבא");

    const smRevoke = await api("POST", "/api/system-admin/revoke-supervisor", { password: "test-system-admin-password-9427", user_id: smTargetUser.id });
    assert(
      smRevoke.status === 200 && !smRevoke.data.user.roles.split(",").filter(Boolean).includes("supervisor"),
      "הסרת מפקח (לתיקון טעות) עובדת גם היא ישירות עם הסיסמה הנכונה"
    );
    assert(smRevoke.data.user.roles.includes("private"), "הסרת מפקח לא פוגעת בשאר התפקידים הקיימים של המשתמש (private נשאר)");

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

    console.log("\n🗑️ מחיקת תנועה - משוב אמיתי: 'אני לא רואה שיש אפשרות למחוק נתונים'");
    // הנתיב עצמו (DELETE /api/transactions/:id) כבר היה קיים בשרת - המשוב היה שאין לו כפתור בממשק
    // בכלל (ר' תיקון ב-public/app.html, deleteTransaction). כאן בודקים את ה-API עצמו מקצה לקצה.
    const txToDelete = await api("POST", "/api/transactions", { type: "expense", amount: 33, category: "למחיקה" }, token);
    assert(txToDelete.status === 201, "יצירת תנועה זמנית לצורך בדיקת המחיקה הצליחה");
    const txToDeleteId = txToDelete.data.transaction.id;
    const otherUserSignup = await api("POST", "/api/auth/signup", {
      full_name: "משתמש זר למחיקה", username: `stranger_delete_${Date.now()}`, password: "1234", phone: `+97250${Date.now().toString().slice(-7)}`,
    });
    const otherUserToken = otherUserSignup.data.token;
    const strangerDeleteAttempt = await api("DELETE", `/api/transactions/${txToDeleteId}`, null, otherUserToken);
    assert(strangerDeleteAttempt.status === 404, "משתמש אחר לא יכול למחוק תנועה שאינה שלו (404, לא חושף מידע)");
    const stillThere = await api("GET", "/api/transactions", null, token);
    assert(stillThere.data.transactions.some(t => t.id === txToDeleteId), "התנועה עדיין קיימת אחרי ניסיון המחיקה הזר שנחסם");
    const realDelete = await api("DELETE", `/api/transactions/${txToDeleteId}`, null, token);
    assert(realDelete.status === 200, "הבעלים האמיתי כן יכול למחוק את התנועה שלו");
    const afterRealDelete = await api("GET", "/api/transactions", null, token);
    assert(!afterRealDelete.data.transactions.some(t => t.id === txToDeleteId), "התנועה אכן נעלמה מהרשימה אחרי המחיקה");
    const deleteAgain = await api("DELETE", `/api/transactions/${txToDeleteId}`, null, token);
    assert(deleteAgain.status === 404, "ניסיון למחוק תנועה שכבר נמחקה מחזיר 404, לא קורס");

    console.log("\n✏️ עריכת תנועה רגילה - משוב אמיתי: 'אפשרות לבחור כמה ואח\"כ בלחיצה אחת שיהיה ערוך מסומנים'");
    // התנועות הרגילות היו היחידות בלי PUT בכלל (רק חתונה/דירה יכלו להיערך) - נדרש כבסיס לעריכה
    // מרובה (שקוראת לנתיב הזה בלולאה, אחת לכל תנועה מסומנת - ר' bulkEditTransactions ב-app.html).
    const txToEdit = await api("POST", "/api/transactions", { type: "expense", amount: 40, category: "לעריכה" }, token);
    const txToEditId = txToEdit.data.transaction.id;
    const otherUserEditSignup = await api("POST", "/api/auth/signup", {
      full_name: "משתמש זר לעריכה", username: `stranger_edit_${Date.now()}`, password: "1234", phone: `+97250${Date.now().toString().slice(-7)}`,
    });
    const strangerEditAttempt = await api("PUT", `/api/transactions/${txToEditId}`, { amount: 1 }, otherUserEditSignup.data.token);
    assert(strangerEditAttempt.status === 404, "משתמש אחר לא יכול לערוך תנועה שאינה שלו");
    const realEdit = await api("PUT", `/api/transactions/${txToEditId}`, { category: "אחרי עריכה" }, token);
    assert(
      realEdit.status === 200 && realEdit.data.transaction.category === "אחרי עריכה" && realEdit.data.transaction.amount === 40,
      `עריכת קטגוריה בלבד הצליחה, בלי לאבד את הסכום שלא נשלח מחדש (${JSON.stringify(realEdit.data.transaction)})`
    );
    await api("DELETE", `/api/transactions/${txToEditId}`, null, token);

    console.log("\n➡️ העברת תנועה מהתנועות הרגילות לחתונה/דירה - משוב אמיתי: 'יש בדפי הבנק שקשורים לדירה או חתונה, אז צריך שיהיה כפתור שאני יכול להעביר אליו'");
    const txToMove = await api("POST", "/api/transactions", { type: "expense", amount: 5000, category: "אולם", note: "מקדמה לאולם חתונה" }, token);
    const txToMoveId = txToMove.data.transaction.id;
    const moveResult = await api("POST", "/api/transactions/move", { from: "regular", id: txToMoveId, to: "wedding" }, token);
    assert(
      moveResult.status === 200 && moveResult.data.transaction.amount === 5000 && moveResult.data.transaction.note === "מקדמה לאולם חתונה",
      `העברת תנועה מהתנועות הרגילות לחתונה הצליחה ושמרה על הפרטים (${JSON.stringify(moveResult.data)})`
    );
    const movedWeddingId = moveResult.data.transaction.id;

    const txsAfterMove = await api("GET", "/api/transactions", null, token);
    const originalRowAfterMove = txsAfterMove.data.transactions.find(t => t.id === txToMoveId);
    assert(
      originalRowAfterMove && originalRowAfterMove.moved_to === "wedding",
      `תוקן (משוב אמיתי: "שיהיה לי אפשרות להציג... אני רואה את הפרטים לאן הועבר") - השורה המקורית לא נמחקה, נשארת עם ציון היעד (${JSON.stringify(originalRowAfterMove)})`
    );
    // הערה: movedWeddingId הוא מזהה מטבלת wedding_transactions - סדרת autoincrement נפרדת מזו של
    // transactions, כך שהשוואת מזהים בין הטבלאות לא אומרת כלום (עלולה "להתנגש" במקרה עם מזהה קיים
    // ולתת נכשל-שווא). הבדיקה האמיתית: ההעברה היא UPDATE על השורה הקיימת, לא הוספת שורה חדשה -
    // צריכה להישאר בדיוק שורה אחת עם המזהה המקורי בתנועות הרגילות.
    assert(
      txsAfterMove.data.transactions.filter(t => t.id === txToMoveId).length === 1,
      "ההעברה עדכנה את השורה הקיימת במקום, ולא יצרה שורה כפולה בתנועות הרגילות"
    );
    assert(
      txsAfterMove.data.summary.expense === 0 || !txsAfterMove.data.transactions.some(t => t.id === txToMoveId && !t.moved_to),
      "תנועה שהועברה מוחרגת מהסכום הכולל של התנועות הרגילות (לא נספרת פעמיים)"
    );
    const weddingAfterMove = await api("GET", "/api/wedding/transactions", null, token);
    assert(weddingAfterMove.data.transactions.some(t => t.id === movedWeddingId && t.category === "אולם"), "התנועה שהועברה אכן מופיעה בתקציב החתונה");

    const reMoveAttempt = await api("POST", "/api/transactions/move", { from: "regular", id: txToMoveId, to: "apartment" }, token);
    assert(reMoveAttempt.status === 400, "לא ניתן להעביר שוב תנועה שכבר הועברה בעבר");

    console.log("\n➡️ העברת תנועה - זיהוי כפילות אפשרית ביעד - משוב אמיתי: 'במידה ויש כפל שהמערכת תשאל ותזהה שיש כפל'");
    // תנועה קיימת בדירה עם סכום+סוג ספציפיים, ותאריך "עכשיו" (ברירת המחדל) - ותנועה רגילה חדשה
    // עם אותו סכום+סוג בדיוק, שנוצרת גם היא "עכשיו" (אותו יום) - ניסיון להעביר אותה לדירה אמור להיתקל בחשד כפילות.
    const existingInApartment = await api("POST", "/api/apartment/transactions", { type: "expense", amount: 1234, category: "רגיל" }, token);
    const todayTx = await api("POST", "/api/transactions", { type: "expense", amount: 1234, category: "אולם" }, token);
    const dupMoveAttempt = await api("POST", "/api/transactions/move", { from: "regular", id: todayTx.data.transaction.id, to: "apartment" }, token);
    assert(
      dupMoveAttempt.status === 409 && dupMoveAttempt.data.error === "duplicate_suspected",
      `זוהתה כפילות אפשרית (אותו סכום+סוג+תאריך כבר קיים ביעד) - לא הועבר אוטומטית בלי אזהרה (${JSON.stringify(dupMoveAttempt.data)})`
    );
    const dupMoveForced = await api("POST", "/api/transactions/move", { from: "regular", id: todayTx.data.transaction.id, to: "apartment", force: true }, token);
    assert(dupMoveForced.status === 200, "עם force:true, ההעברה מתבצעת בכל זאת למרות חשד הכפילות");

    console.log("\n➡️ העברת תנועה עם דריסת קטגוריה - משוב אמיתי: 'תוסיף שיהיה קטגוריה בתוך חתונה - ביגוד וכו''");
    // תנועה רגילה עם קטגוריה חופשית ("קניה בבגדים") שאינה אחת מהקטגוריות הקבועות של חתונה בכלל -
    // ההעברה כוללת category מפורש מרשימת הקטגוריות הקבועות של היעד, שאמור לדרוס את הקטגוריה המקורית.
    const txForCategoryOverride = await api("POST", "/api/transactions", { type: "expense", amount: 300, category: "קניה בבגדים" }, token);
    const overrideMove = await api(
      "POST", "/api/transactions/move",
      { from: "regular", id: txForCategoryOverride.data.transaction.id, to: "wedding", category: "ביגוד" },
      token
    );
    assert(
      overrideMove.status === 200 && overrideMove.data.transaction.category === "ביגוד",
      `הקטגוריה שנשלחה בבקשת ההעברה (מרשימת הקטגוריות הקבועות של היעד) דורסת את הקטגוריה המקורית (${JSON.stringify(overrideMove.data)})`
    );

    console.log("\n➡️ 'העברה' להלוואות - קישור תנועה קיימת (לא טבלת יעד נפרדת) - משוב אמיתי: 'אין אופציה העבר להלוואות'");
    // בניגוד לחתונה/דירה, "העברה" להלוואות היא לא POST /api/transactions/move (אין wedding_transactions
    // מקביל להלוואות) - היא סתם PUT עם loan_id על התנועה הרגילה הקיימת, שנשארת בתנועות הרגילות.
    const loanForLinkTest = await api("POST", "/api/loans", { name: "הלוואה לבדיקת קישור מהתנועות", total_installments: 10, start_date: "2026-01-01" }, token);
    const loanIdForLink = loanForLinkTest.data.loan.id;
    const txForLoanLink = await api("POST", "/api/transactions", { type: "expense", amount: 400, category: "תשלום מהבנק" }, token);
    const linkToLoan = await api("PUT", `/api/transactions/${txForLoanLink.data.transaction.id}`, { loan_id: loanIdForLink }, token);
    assert(
      linkToLoan.status === 200 && linkToLoan.data.transaction.loan_id == loanIdForLink && linkToLoan.data.transaction.moved_to === null,
      `תנועה רגילה קושרה להלוואה בלי לעבור לטבלה אחרת ובלי להיות מסומנת כ"הועברה" (${JSON.stringify(linkToLoan.data)})`
    );

    // ניקוי - הבדיקות הבאות (חתונה/דירה/מעשרות) מניחות בסיס נקי, ומשתמשות באותו token/משתמש משותף
    // לאורך כל הקובץ - בלי הניקוי הזה, התנועות שהועברו/נוצרו כאן "דולפות" לסכומים המדויקים שם.
    await api("DELETE", `/api/wedding/transactions/${movedWeddingId}`, null, token);
    await api("DELETE", `/api/apartment/transactions/${existingInApartment.data.transaction.id}`, null, token);
    await api("DELETE", `/api/apartment/transactions/${dupMoveForced.data.transaction.id}`, null, token);
    await api("DELETE", `/api/wedding/transactions/${overrideMove.data.transaction.id}`, null, token);
    await api("DELETE", `/api/loans/${loanIdForLink}`, null, token);

    console.log("\n📥 ייבוא אקסל/CSV של דף בנק - זיהוי עמודות זכות/חובה אוטומטי");
    // משוב אמיתי ממשתמש: "רוצה להכניס אקסל של דפי בנק או דפי כרטיס אשראי, שיוכל להוריד אותו
    // והמערכת תכניס את זה להכנסות והוצאות". ר' src/lib/xlsxParser.js, src/lib/importMapping.js,
    // src/routes/importTransactions.js.
    const bankRows = [
      ["תאריך", "תיאור פעולה", "זכות", "חובה"],
      [45658, "משכורת ינואר", 5000, 0],   // 2025-01-01, ר' xlsxParser excelSerialToIsoDate
      [45660, "סופר פארם", 0, 120.5],     // 2025-01-03
      [45661, "שורה בלי תנועה בפועל", 0, 0], // צריכה להידלג - שתי העמודות אפס
    ];
    const bankXlsxBuf = buildTestXlsx(bankRows, 0);
    const bankImportPreview = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: bankXlsxBuf.toString("base64"), filename: "bank-statement.xlsx", source_type: "bank" },
      token
    );
    assert(bankImportPreview.status === 200, `תצוגה מקדימה של ייבוא דף בנק (xlsx) הצליחה (סטטוס ${bankImportPreview.status})`);
    assert(bankImportPreview.data.transactions.length === 2, `זוהו בדיוק 2 תנועות תקינות מתוך 3 שורות (השורה עם 0/0 דולגה) (${bankImportPreview.data.transactions.length})`);
    assert(
      bankImportPreview.data.detectedColumns.creditCol === 2 && bankImportPreview.data.detectedColumns.debitCol === 3,
      "עמודות 'זכות'/'חובה' זוהו אוטומטית לפי כותרות העמודות בעברית"
    );
    const bankIncomeRow = bankImportPreview.data.transactions.find(t => t.amount === 5000);
    assert(
      bankIncomeRow && bankIncomeRow.type === "income" && bankIncomeRow.date === "2025-01-01" && bankIncomeRow.description === "משכורת ינואר",
      "שורת 'זכות' זוהתה כהכנסה, עם התאריך הנכון (הומר ממספר סידורי של אקסל) והתיאור הנכון"
    );
    const bankExpenseRow = bankImportPreview.data.transactions.find(t => t.amount === 120.5);
    assert(bankExpenseRow && bankExpenseRow.type === "expense" && bankExpenseRow.date === "2025-01-03", "שורת 'חובה' זוהתה כהוצאה, עם התאריך הנכון");
    assert(
      bankImportPreview.data.transactions.every(t => t.alreadyImported === false),
      "לפני הייבוא בפועל, אף תנועה לא מסומנת כ'כבר יובאה'"
    );
    // משוב אמיתי: "בדפי הבנק יש פרטים שלאחר יבוא לא רואים אותם - אני צריך את כל הנתונים בצד" -
    // כל עמודות שורת המקור (לא רק date/description/amount/type שנבחרו לתנועה) אמורות להישמר תחת raw.
    assert(
      Array.isArray(bankIncomeRow.raw) &&
      bankIncomeRow.raw.some(c => c.label === "תיאור פעולה" && c.value === "משכורת ינואר") &&
      bankIncomeRow.raw.some(c => c.label === "זכות" && Number(c.value) === 5000),
      `התצוגה המקדימה כוללת raw עם כל עמודות השורה המקורית, לא רק את מה שנבחר לתנועה (${JSON.stringify(bankIncomeRow.raw)})`
    );

    const bankImportCommit = await api("POST", "/api/transactions/import/commit", { transactions: bankImportPreview.data.transactions }, token);
    assert(
      bankImportCommit.status === 201 && bankImportCommit.data.imported === 2 && bankImportCommit.data.skippedDuplicates === 0,
      `שמירת התנועות שאושרו בתצוגה המקדימה הצליחה, שתיהן נשמרו בפעם הראשונה (${JSON.stringify(bankImportCommit.data)})`
    );
    const afterBankImport = await api("GET", "/api/transactions", null, token);
    assert(
      afterBankImport.data.transactions.some(t => t.source === "import" && t.amount === 5000 && t.type === "income" && t.note === "משכורת ינואר") &&
      afterBankImport.data.transactions.some(t => t.source === "import" && t.amount === 120.5 && t.type === "expense"),
      "התנועות שיובאו נשמרו במסד הנתונים עם source='import' והתיאור המקורי כ-note"
    );
    const importedIncomeRow = afterBankImport.data.transactions.find(t => t.source === "import" && t.amount === 5000);
    const savedRaw = importedIncomeRow.raw_data ? JSON.parse(importedIncomeRow.raw_data) : null;
    assert(
      Array.isArray(savedRaw) && savedRaw.some(c => c.label === "תיאור פעולה" && c.value === "משכורת ינואר"),
      `raw_data נשמר גם אחרי הייבוא בפועל (לא רק בתצוגה המקדימה) - נגיש דרך GET /api/transactions (${JSON.stringify(savedRaw)})`
    );

    console.log("\n📥 ייבוא אקסל - מניעת כפילויות (אותו קובץ פעמיים)");
    const bankImportPreviewAgain = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: bankXlsxBuf.toString("base64"), filename: "bank-statement.xlsx", source_type: "bank" },
      token
    );
    assert(
      bankImportPreviewAgain.data.transactions.every(t => t.alreadyImported === true),
      "בהעלאה חוזרת של אותו קובץ בדיוק, כל התנועות כבר מסומנות כ'כבר יובאו' בתצוגה המקדימה"
    );
    const bankImportCommitAgain = await api("POST", "/api/transactions/import/commit", { transactions: bankImportPreviewAgain.data.transactions }, token);
    assert(
      bankImportCommitAgain.data.imported === 0 && bankImportCommitAgain.data.skippedDuplicates === 2,
      `ניסיון לייבא את אותו קובץ שוב לא יוצר תנועות כפולות - שתיהן דולגו כ'כבר קיים' (${JSON.stringify(bankImportCommitAgain.data)})`
    );
    const afterBankImportAgain = await api("GET", "/api/transactions", null, token);
    assert(
      afterBankImportAgain.data.transactions.filter(t => t.source === "import" && t.amount === 5000).length === 1,
      "אחרי הניסיון החוזר עדיין קיימת רק תנועה אחת בודדת של אותה משכורת - לא נוצרה כפילות במסד הנתונים"
    );

    console.log("\n📥 ייבוא CSV של כרטיס אשראי - עמודת סכום יחידה, זיכוי מזוהה כהכנסה");
    const cardCsvText =
      "תאריך,תיאור,סכום\n" +
      "05/02/2026,סופרמרקט,250.90\n" +
      "06/02/2026,זיכוי החזר,-41.5\n";
    const cardImportPreview = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: Buffer.from(cardCsvText, "utf8").toString("base64"), filename: "card-statement.csv", source_type: "card" },
      token
    );
    assert(cardImportPreview.status === 200 && cardImportPreview.data.transactions.length === 2, "תצוגה מקדימה של ייבוא כרטיס אשראי (CSV) זיהתה 2 תנועות");
    const cardCharge = cardImportPreview.data.transactions.find(t => t.amount === 250.9);
    assert(cardCharge && cardCharge.type === "expense" && cardCharge.date === "2026-02-05", "חיוב רגיל בכרטיס אשראי (סכום חיובי) זוהה כהוצאה, עם תאריך dd/mm/yyyy שהומר נכון ל-ISO");
    const cardCredit = cardImportPreview.data.transactions.find(t => t.amount === 41.5);
    assert(cardCredit && cardCredit.type === "income", "שורת זיכוי בכרטיס אשראי (סכום שלילי) זוהתה כהכנסה, לא כהוצאה");
    const cardImportCommit = await api(
      "POST", "/api/transactions/import/commit",
      { transactions: cardImportPreview.data.transactions.map(t => ({ ...t, category: "אחר" })) },
      token
    );
    assert(cardImportCommit.data.imported === 2, "שתי תנועות הכרטיס נשמרו בהצלחה עם קטגוריה שנבחרה בתצוגה המקדימה");

    console.log("\n📥 ייבוא CSV של דף בנק - עמודות סכום/יתרה בלי כותרת טקסט בכלל (נבדק מול קובץ אמיתי)");
    // תוקן בעקבות קובץ Excel אמיתי (ייצוא "עובר ושב"): הבנק משאיר את כותרות עמודות הסכום/היתרה
    // *ריקות לגמרי* בטקסט (העמודות עצמן קיימות עם מספרים אמיתיים - פשוט בלי כותרת). ר'
    // guessUnlabeledAmountColumn ב-importMapping.js. גם בודקים שעמודת "יום ערך" (תאריך ערך נוסף,
    // לא עמודת התאריך הראשית) לא נתפסת בטעות כעמודת הסכום - היא "מצליחה" להיקרא כמספר (למשל
    // "2026" מתוך "2026-08-21") אם לא בודקים במפורש שזו מחרוזת תאריך ומדלגים עליה.
    const noHeaderAmountCsv =
      "תאריך,יום ערך,תיאור התנועה,,,אסמכתה\n" +
      "2026-08-21,2026-08-21,תשלום שכירות,-2500,-1000,111\n" +
      "2026-08-19,2026-08-20,משכורת,5000,2500,112\n";
    const noHeaderAmountImport = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: Buffer.from(noHeaderAmountCsv, "utf8").toString("base64"), filename: "over-veshav.csv", source_type: "bank" },
      token
    );
    assert(
      noHeaderAmountImport.status === 200 && noHeaderAmountImport.data.transactions.length === 2,
      `ייבוא הצליח למרות שעמודות הסכום/יתרה חסרות כותרת טקסט (${JSON.stringify(noHeaderAmountImport.data)})`
    );
    const rentRow = noHeaderAmountImport.data.transactions.find(t => t.amount === 2500 && t.description === "תשלום שכירות");
    assert(rentRow && rentRow.type === "expense", "סכום שלילי (-2500) בעמודה ללא כותרת זוהה נכון כהוצאה, לא נתפס בטעות כתאריך/מספר אחר");
    const salaryRow = noHeaderAmountImport.data.transactions.find(t => t.amount === 5000 && t.description === "משכורת");
    assert(salaryRow && salaryRow.type === "income", "סכום חיובי (5000) בעמודה ללא כותרת זוהה נכון כהכנסה");
    assert(
      !noHeaderAmountImport.data.transactions.some(t => t.amount === 2026),
      "עמודת 'יום ערך' (גם היא תאריך, לא עמודת הסכום) לא נתפסה בטעות כעמודת סכום (הבאג המקורי - קריאת '2026' מתוך תאריך כסכום)"
    );

    console.log("\n📥 ייבוא CSV של דף בנק - תיאור חלופי ('הפעולה') כשעמודת 'פרטים' ריקה בשורה הספציפית");
    // תוקן בעקבות קובץ Excel אמיתי (מזרחי טפחות): עמודת "פרטים" היא התיאור הכי מדויק כשהיא מלאה
    // ("לטובת: ..."), אבל ריקה בהרבה שורות (הוראות קבע/עמלות) - שם "הפעולה" (למשל "הו\"ק הלו' רבית")
    // היא התיאור השימושי היחיד. ר' HEADER_KEYWORDS.descriptionFallback ב-importMapping.js.
    const descFallbackCsv =
      "תאריך,הפעולה,פרטים,חובה,זכות\n" +
      "23/08/2026,העברה לאחר,לטובת: ראובן כהן,60,\n" +
      "20/08/2026,הו\"ק הלו' רבית,,434.29,\n";
    const descFallbackImport = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: Buffer.from(descFallbackCsv, "utf8").toString("base64"), filename: "mizrahi.csv", source_type: "bank" },
      token
    );
    assert(descFallbackImport.status === 200 && descFallbackImport.data.transactions.length === 2, "ייבוא עם עמודת תיאור חלופית ('הפעולה') הצליח");
    const filledDescRow = descFallbackImport.data.transactions.find(t => t.amount === 60);
    assert(filledDescRow && filledDescRow.description === "לטובת: ראובן כהן", "כש'פרטים' מלא, הוא עדיין העדיפות הראשונה - לא מוחלף ב'הפעולה'");
    const emptyDescRow = descFallbackImport.data.transactions.find(t => t.amount === 434.29);
    assert(emptyDescRow && emptyDescRow.description === "הו\"ק הלו' רבית", "כש'פרטים' ריק בשורה הזו בלבד, נופלים ל'הפעולה' כתיאור, במקום להשאיר תיאור ריק");

    console.log("\n📥 ייבוא CSV של דף בנק - תיאור מורחב ('תאור מורחב') עדיף כשהוא מלא (בנק לאומי)");
    // תוקן בעקבות קובץ Excel אמיתי (בנק לאומי): עמודת "תיאור" שם כמעט תמיד גנרית ולא-ריקה ("כרטיס
    // דביט" לעשרות שורות שונות) - ההפך מהמקרה של מזרחי טפחות: כאן העמודה השימושית ("תאור מורחב",
    // למשל פרטי העברה מלאים) *עדיפה כשהיא כן מלאה*, לא רק גיבוי לכשהראשית ריקה. ר' HEADER_KEYWORDS.descriptionExtended.
    const descExtendedCsv =
      "תאריך,תיאור,חובה,זכות,תאור מורחב\n" +
      "23/08/2026,כרטיס דביט,420,,\n" +
      "24/08/2026,הע. אינטרנט,1000,,TRANSFER TO: MIZRAHI TEFAHOT BANK\n";
    const descExtendedImport = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: Buffer.from(descExtendedCsv, "utf8").toString("base64"), filename: "leumi.csv", source_type: "bank" },
      token
    );
    assert(descExtendedImport.status === 200 && descExtendedImport.data.transactions.length === 2, "ייבוא עם עמודת 'תאור מורחב' הצליח");
    const noExtendedRow = descExtendedImport.data.transactions.find(t => t.amount === 420);
    assert(noExtendedRow && noExtendedRow.description === "כרטיס דביט", "כש'תאור מורחב' ריק בשורה הזו, נשארים עם התיאור הראשי הרגיל ('כרטיס דביט')");
    const hasExtendedRow = descExtendedImport.data.transactions.find(t => t.amount === 1000);
    assert(
      hasExtendedRow && hasExtendedRow.description === "TRANSFER TO: MIZRAHI TEFAHOT BANK",
      "כש'תאור מורחב' מלא, הוא מחליף את התיאור הראשי הגנרי ('הע. אינטרנט') - לא רק גיבוי לכשהראשי ריק, אלא עדיפות כשהוא כן מלא"
    );

    console.log("\n📥 ייבוא אקסל - טיפול בשגיאות (קובץ לא תקין / בלי עמודות מוכרות)");
    const badBase64Import = await api("POST", "/api/transactions/import/parse", { data_base64: "not-a-real-file!!", filename: "x.xlsx", source_type: "bank" }, token);
    assert(badBase64Import.status === 400, "קובץ xlsx לא תקין (לא ZIP אמיתי) מחזיר שגיאה ברורה, לא קורס");
    const noHeadersCsv = "שלום,עולם\nמשהו,אחר\n";
    const noHeadersImport = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: Buffer.from(noHeadersCsv, "utf8").toString("base64"), filename: "x.csv", source_type: "bank" },
      token
    );
    assert(
      noHeadersImport.status === 400 && /תאריך|כותר/.test(noHeadersImport.data.error),
      "קובץ בלי עמודות מוכרות (תאריך/סכום/זכות/חובה) מחזיר הודעת שגיאה ברורה במקום לנסות לייבא זבל"
    );

    console.log("\n📥 ייבוא 'אקסל' שהוא בפועל טבלת HTML עם סיומת .xls (טריק נפוץ אצל בנקים בישראל)");
    // תוקן בעקבות קובץ אמיתי מהמשתמש (ייצוא "AccountActivity.xls" מבנק מרכנתיל-דיסקונט) - זהו לא
    // ZIP אמיתי (xlsx) ולא CSV, אלא טבלת HTML פשוטה עם עמודת "סוג תנועה" (לא "תיאור"), ערכים ריקים
    // כ-&nbsp;, וסכומים עם פסיקי אלפים. המבנה הסינתטי כאן משקף את המבנה האמיתי (כולל שורות "רעש"
    // לפני שורת הכותרות האמיתית) אבל עם נתונים בדויים, לא הנתונים האמיתיים של המשתמש.
    const htmlBankTable =
      '<html dir="rtl" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><title>Test</title></head><body>' +
      "<table><tr><td><b>יתרה ותנועות בחשבון</b></td></tr><tr><td>&nbsp;</td></tr>" +
      "<tr><td><b>מספר חשבון:</b></td><td>111-222 ישראל ישראלי</td></tr><tr><td>&nbsp;</td></tr></table>" +
      "<table><tr><td>יתרה בחשבון: </td><td> 1,234.56</td><td> לתאריך -</td><td>01/01/26 10:00</td></tr>" +
      "<tr><td>מסגרת אשראי: </td><td> 5,000.00</td></tr><tr><td>&nbsp;</td></tr>" +
      "<tr><td><b>תנועות אחרונות</b></td></tr><tr><td>&nbsp;</td></tr>" +
      '<tr><td style="background-color:#808080;color:White;"><b> תאריך</b></td><td style="background-color:#808080;color:White;"><b>תאריך ערך</b></td>' +
      '<td style="background-color:#808080;color:White;"><b>סוג תנועה</b></td><td style="background-color:#808080;color:White;"><b>זכות</b></td>' +
      '<td style="background-color:#808080;color:White;"><b>חובה</b></td><td style="background-color:#808080;color:White;"><b>יתרה בש"ח</b></td>' +
      '<td style="background-color:#808080;color:White;"><b>אסמכתא</b></td></tr>' +
      "<tr><td> 05/01/26</td><td>&nbsp;</td><td>זיכוי משכורת</td><td> 4,500.00</td><td>&nbsp;</td><td>&nbsp;</td><td>1001</td></tr>" +
      "<tr><td> 06/01/26</td><td>&nbsp;</td><td>כספומט</td><td>&nbsp;</td><td> 300.00</td><td>&nbsp;</td><td>1002</td></tr>" +
      "</table></body></html>";
    const htmlImportPreview = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: Buffer.from(htmlBankTable, "utf8").toString("base64"), filename: "AccountActivity.xls", source_type: "bank" },
      token
    );
    assert(
      htmlImportPreview.status === 200 && htmlImportPreview.data.transactions.length === 2,
      `ייבוא קובץ HTML עם סיומת .xls הצליח וזיהה 2 תנועות אמיתיות, דילג על שורות ה'רעש' (${JSON.stringify(htmlImportPreview.data)})`
    );
    assert(
      htmlImportPreview.data.detectedColumns.descCol >= 0,
      "עמודת 'סוג תנועה' (שאינה נקראת 'תיאור' במפורש) זוהתה בכל זאת כעמודת התיאור"
    );
    const htmlIncomeRow = htmlImportPreview.data.transactions.find(t => t.amount === 4500);
    assert(
      htmlIncomeRow && htmlIncomeRow.type === "income" && htmlIncomeRow.date === "2026-01-05" && htmlIncomeRow.description === "זיכוי משכורת",
      "שורת 'זכות' עם סכום מופרד בפסיקים (4,500.00) ותאריך דו-ספרתי (05/01/26) זוהתה נכון כהכנסה"
    );
    const htmlExpenseRow = htmlImportPreview.data.transactions.find(t => t.amount === 300);
    assert(htmlExpenseRow && htmlExpenseRow.type === "expense" && htmlExpenseRow.date === "2026-01-06", "שורת 'חובה' זוהתה נכון כהוצאה");
    const htmlImportCommit = await api("POST", "/api/transactions/import/commit", { transactions: htmlImportPreview.data.transactions }, token);
    assert(htmlImportCommit.data.imported === 2, "שתי התנועות מקובץ ה-HTML נשמרו בהצלחה");

    console.log("\n📥 ייבוא - קובץ .xls ישן אמיתי (בינארי, לא נתמך) מקבל הודעת שגיאה ממוקדת");
    const legacyXlsBuffer = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const legacyXlsImport = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: legacyXlsBuffer.toString("base64"), filename: "old.xls", source_type: "bank" },
      token
    );
    assert(
      legacyXlsImport.status === 400 && /xlsx|csv/.test(legacyXlsImport.data.error),
      "קובץ .xls ישן אמיתי (בינארי, פורמט Excel 97-2003) מזוהה במפורש ומקבל הנחיה ברורה לשמור מחדש כ-xlsx/csv, לא כישלון סתום"
    );

    console.log("\n📥 ייבוא דף חיוב בפורמט PDF (דף כרטיס אשראי) - נבדק במקור מול קובץ אמיתי מכאל");
    // תוקן/נבנה בעקבות בקשת פיצ'ר ("PDF תוכל גם לפענח?") ובדיקה מול קובץ אמיתי (דף פירוט דיגיטלי
    // של כאל) - ר' src/lib/pdfParser.js. בדיקת ה-API כאן משתמשת ב-PDF סינתטי (tests/helpers/
    // buildTestPdf.js, לא הקובץ האמיתי - שלא נשמר בריפו) שממדל את מבנה הטבלה (תאריך/שם בית העסק/
    // סכום) בלי לשכפל את הקוונטיות המדויקת של פיצול תו-אחר-תו שהתגלתה בקובץ האמיתי - זו נבדקת
    // בנפרד ובאופן ממוקד יותר ב-reorderRunsForReading למטה.
    const pdfBuffer = buildTestPdf([
      { text: "תאריך", x: 500, y: 700 },
      { text: "שם בית העסק", x: 350, y: 700 },
      { text: "סכום", x: 100, y: 700 },
      { text: "01/02/2026", x: 500, y: 680 },
      { text: "סופר גדול", x: 350, y: 680 },
      { text: "₪ 150.00", x: 100, y: 680 },
      { text: "02/02/2026", x: 500, y: 660 },
      { text: "בית קפה", x: 350, y: 660 },
      { text: "45.50", x: 100, y: 660 },
    ]);
    const pdfImportPreview = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: pdfBuffer.toString("base64"), filename: "cal-statement.pdf", source_type: "card" },
      token
    );
    assert(
      pdfImportPreview.status === 200 && pdfImportPreview.data.transactions.length === 2,
      `ייבוא PDF סינתטי הצליח וזיהה 2 תנועות (${JSON.stringify(pdfImportPreview.data)})`
    );
    const pdfRow1 = pdfImportPreview.data.transactions.find(t => t.amount === 150);
    assert(
      pdfRow1 && pdfRow1.date === "2026-02-01" && pdfRow1.description === "סופר גדול" && pdfRow1.type === "expense",
      "שורה ראשונה מה-PDF זוהתה נכון: תאריך, שם בית עסק (עברית) וסכום - עם ברירת המחדל 'הוצאה' לכרטיס אשראי"
    );
    const pdfRow2 = pdfImportPreview.data.transactions.find(t => t.amount === 45.5);
    assert(pdfRow2 && pdfRow2.date === "2026-02-02" && pdfRow2.description === "בית קפה", "שורה שנייה מה-PDF זוהתה נכון");
    const pdfImportCommit = await api("POST", "/api/transactions/import/commit", { transactions: pdfImportPreview.data.transactions, filename: "cal-statement.pdf" }, token);
    assert(pdfImportCommit.data.imported === 2, "שתי התנועות מה-PDF נשמרו בהצלחה");
    assert(typeof pdfImportCommit.data.batchId === "string" && pdfImportCommit.data.batchId.length > 0, "ה-commit מחזיר batchId (מזהה אצווה) לתנועות שנשמרו בפועל");

    console.log("\n📥 ייבוא - מחיקת קובץ ייבוא שלם בבת אחת (משוב אמיתי: 'אם הבאתי דפי בנק ואני רוצה למחוק את הקבצים שהועלו')");
    const batchesBeforeDelete = await api("GET", "/api/transactions/import/batches", null, token);
    assert(batchesBeforeDelete.status === 200, `רשימת קבצי ייבוא הצליחה (סטטוס ${batchesBeforeDelete.status})`);
    const calBatch = batchesBeforeDelete.data.batches.find(b => b.batchId === pdfImportCommit.data.batchId);
    assert(
      calBatch && calBatch.filename === "cal-statement.pdf" && calBatch.count === 2 && calBatch.expense === 195.5,
      `הקובץ שיובא (PDF) מופיע ברשימת האצוות עם שם הקובץ, מספר התנועות והסכום הנכונים (${JSON.stringify(calBatch)})`
    );
    const otherUserBatchSignup = await api("POST", "/api/auth/signup", {
      full_name: "משתמש זר למחיקת אצווה", username: `stranger_batch_${Date.now()}`, password: "1234", phone: `+97250${Date.now().toString().slice(-7)}`,
    });
    const otherUserBatchDelete = await api("DELETE", `/api/transactions/import/batches/${pdfImportCommit.data.batchId}`, null, otherUserBatchSignup.data.token);
    assert(otherUserBatchDelete.status === 404, "משתמש אחר לא יכול למחוק אצוות ייבוא ששייכות למשתמש הזה");
    const batchDelete = await api("DELETE", `/api/transactions/import/batches/${pdfImportCommit.data.batchId}`, null, token);
    assert(
      batchDelete.status === 200 && batchDelete.data.deleted === 2,
      `מחיקת קובץ הייבוא כולו מחקה בדיוק את שתי התנועות שהגיעו ממנו (${JSON.stringify(batchDelete.data)})`
    );
    const afterBatchDelete = await api("GET", "/api/transactions", null, token);
    assert(
      !afterBatchDelete.data.transactions.some(t => t.import_batch_id === pdfImportCommit.data.batchId),
      "אחרי מחיקת האצווה, אף תנועה מהקובץ שנמחק לא נשארה ברשימת התנועות"
    );
    const batchesAfterDelete = await api("GET", "/api/transactions/import/batches", null, token);
    assert(
      !batchesAfterDelete.data.batches.some(b => b.batchId === pdfImportCommit.data.batchId),
      "האצווה שנמחקה כבר לא מופיעה ברשימת קבצי הייבוא"
    );
    const batchDeleteAgain = await api("DELETE", `/api/transactions/import/batches/${pdfImportCommit.data.batchId}`, null, token);
    assert(batchDeleteAgain.status === 404, "ניסיון למחוק אצווה שכבר נמחקה מחזיר 404, לא קורס");

    console.log("\n📥 ייבוא PDF - שחזור סדר קריאה נכון (bidi) בתוך שורה שבה כל תו הוא ריצת-טקסט נפרדת");
    // משוב אמיתי מבדיקה מול קובץ כאל אמיתי: PDF מצייר שם כל תו (גם בעברית וגם במספרים) כ-Tj נפרד,
    // ממוקם מימין לשמאל - כלומר תאריך כמו "19/07/2026" מגיע כ-10 ריצות-תו בודדות בסדר "הפוך"
    // (6,2,0,2,/,7,0,/,9,1), וטקסט לועזי בתוך ההקשר העברי (כמו "aliexpress") מגיע גם הוא הפוך
    // (s,s,e,r,p,x,e,i,l,a) - בעוד עברית "רגילה" (מילה-אחר-מילה, ריצה בודדת) כבר מגיעה נכון. הבדיקה
    // הזו קוראת ישירות ל-reorderRunsForReading (ולא דרך PDF מלא) כדי לבודד את הלוגיקה העדינה הזו.
    const { reorderRunsForReading } = require("../src/lib/pdfParser");
    const dateRuns = ["6", "2", "0", "2", "/", "7", "0", "/", "9", "1"].map((text, i) => ({ x: 100 - i, y: 0, text }));
    assert(
      reorderRunsForReading(dateRuns) === "19/07/2026",
      "תאריך שמגיע כ-10 ריצות-תו בודדות (מסודרות ימין-לשמאל) משוחזר נכון לסדר הקריאה הרגיל"
    );
    const latinRuns = ["s", "s", "e", "r", "p", "x", "e", "i", "l", "a"].map((text, i) => ({ x: 100 - i, y: 0, text }));
    assert(
      reorderRunsForReading(latinRuns) === "aliexpress",
      "מילה לועזית בתוך הקשר עברי (גם היא מפוצלת לריצות-תו בודדות, גם היא הפוכה) משוחזרת נכון"
    );
    const hebrewWordRuns = [{ x: 130, y: 0, text: "ס" }, { x: 120, y: 0, text: "ו" }, { x: 110, y: 0, text: "פ" }, { x: 100, y: 0, text: "ר" }];
    assert(
      reorderRunsForReading(hebrewWordRuns) === "סופר",
      "מילה עברית שמפוצלת לריצות-תו בודדות (ימין לשמאל) כבר בסדר קריאה נכון - לא הופכים אותה"
    );
    const mixedRuns = [
      { x: 200, y: 0, text: "₪ 13.30" }, // ריצה שלמה, כבר בסדר נכון - כמו שדה סכום אמיתי ב-PDF
      ...["ס", "ו", "פ", "ר"].map((text, i) => ({ x: 100 - i, y: 0, text })),
    ];
    assert(
      reorderRunsForReading(mixedRuns) === "₪ 13.30סופר",
      "ריצה רב-תווית שכבר בסדר נכון (כמו סכום מוכן-מראש) לא נהפכת פנימית, גם כשמעורבת עם ריצות-תו עבריות בודדות"
    );

    console.log("\n📥 ייבוא PDF - קובץ בלי טקסט הניתן לחילוץ (מדמה מסמך סרוק) מקבל שגיאה ברורה");
    const noCmapPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj\n%%EOF", "latin1");
    const noCmapImport = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: noCmapPdf.toString("base64"), filename: "scanned.pdf", source_type: "bank" },
      token
    );
    assert(
      noCmapImport.status === 400 && /טקסט|סרוק/.test(noCmapImport.data.error),
      "PDF בלי גופן/ToUnicode הניתן לחילוץ (מדמה מסמך סרוק) מקבל הודעת שגיאה ברורה, לא קורס"
    );

    console.log("\n📥 ייבוא PDF - עמודת 'זכות/חובה' משולבת + שורת פתיח לפני הנתונים (בנק אמיתי - מזרחי טפחות עו\"ש)");
    // משוב אמיתי (המשתמש שלח קובץ PDF אמיתי, "tnuot.pdf", שנכשל לגמרי - "לא נמצאו עמודות תקינות
    // בקובץ"): גילינו שלוש בעיות אמיתיות ביחד: (1) הטקסט לא מצויר ישירות בזרם התוכן של העמוד אלא
    // בתוך Form XObject מקונן דרך cm+Do (נדרש מעקב CTM/q/Q ופתרון Do רקורסיבי - ר' walkContentStream
    // ב-pdfParser.js). (2) בניגוד לקובץ כאל הקודם, כאן כל *ביטוי* עברי שלם (לא תו-תו) מגיע הפוך-פנימית
    // ב-Tj אחד (ר' התיקון ב-reorderRunsForReading). (3) עמודת הסכום נקראת "זכות/חובה" (לא "סכום") -
    // ערך אחד עם סימן, לא שתי עמודות זכות/חובה נפרדות - "זכות" ו"חובה" תואמות בטעות לאותה עמודה
    // (ר' התיקון ב-importMapping.js). בנוסף שורת "יתרה קודמת נכון ל-..." שמופיעה מיד אחרי הכותרת
    // (לא שורת נתונים אמיתית) הייתה "מזהמת" את חלון הדגימה של guessUnlabeledAmountColumn.
    const mizrahiPdf = buildTestPdf([
      { text: "תאריך", x: 500, y: 700 }, { text: "סוג תנועה", x: 350, y: 700 }, { text: "זכות/חובה", x: 150, y: 700 },
      { text: "יתרה קודמת נכון ל- 31/07/2026", x: 300, y: 685 }, { text: "-9,368.32", x: 150, y: 685 },
      { text: "02/08/2026", x: 500, y: 670 }, { text: "ניוד כספים ממשפחה", x: 350, y: 670 }, { text: "200.00", x: 150, y: 670 },
      { text: "02/08/2026", x: 500, y: 655 }, { text: "הלוואה- פרעון", x: 350, y: 655 }, { text: "-305.05", x: 150, y: 655 },
    ]);
    const mizrahiPreview = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: mizrahiPdf.toString("base64"), filename: "מזרחי-טפחות.pdf", source_type: "bank" },
      token
    );
    assert(
      mizrahiPreview.status === 200 && mizrahiPreview.data.transactions.length === 2,
      `ייבוא PDF עם עמודת 'זכות/חובה' משולבת הצליח וזיהה 2 תנועות, לא נכשל עם 'לא נמצאה עמודת סכום' (${JSON.stringify(mizrahiPreview.data)})`
    );
    const mizrahiIncome = mizrahiPreview.data.transactions.find(t => t.amount === 200);
    assert(
      mizrahiIncome && mizrahiIncome.type === "income" && mizrahiIncome.description === "ניוד כספים ממשפחה" && mizrahiIncome.date === "2026-08-02",
      `שורה עם סכום חיובי ב'זכות/חובה' זוהתה נכון כהכנסה, כולל תיאור עברי רב-מילי שהוחזר לסדר קריאה נכון (${JSON.stringify(mizrahiIncome)})`
    );
    const mizrahiExpense = mizrahiPreview.data.transactions.find(t => t.amount === 305.05);
    assert(
      mizrahiExpense && mizrahiExpense.type === "expense" && mizrahiExpense.description === "הלוואה- פרעון",
      `שורה עם סכום שלילי ב'זכות/חובה' זוהתה נכון כהוצאה (${JSON.stringify(mizrahiExpense)})`
    );

    console.log("\n💍 תקציב חתונה - אזור נפרד לגמרי מהתנועות הרגילות");
    // משוב אמיתי: "שיהיה קטגוריה נפרדת להוצאות חתונה, הכנסות מתרומות... אזור נפרד לגמרי בשם 'חתונה'".
    // ר' src/routes/weddingTransactions.js.
    const weddingCategories = await api("GET", "/api/wedding/categories", null, token);
    assert(
      weddingCategories.status === 200 &&
      weddingCategories.data.income.includes("תרומות") &&
      weddingCategories.data.expense.includes("אולם חתונה") &&
      weddingCategories.data.expense.includes("שמלת כלה"),
      `רשימת קטגוריות החתונה הקבועה כוללת את הפריטים שהמשתמש ביקש (${JSON.stringify(weddingCategories.data)})`
    );
    // תוקן (משוב אמיתי: "אין קטגוריות בתנועות של הלוואות גם בחתונה צריך שיהיה")
    assert(
      weddingCategories.data.income.includes("הלוואות") && weddingCategories.data.expense.includes("הלוואות"),
      "'הלוואות' נוספה גם כהכנסה וגם כהוצאה בקטגוריות החתונה"
    );
    assert(
      ["שבע ברכות - יום 1", "שבע ברכות - יום 2", "שבע ברכות - יום 3", "שבע ברכות - יום 4", "שבע ברכות - יום 5", "שבע ברכות - יום 6"]
        .every(c => weddingCategories.data.expense.includes(c)) && weddingCategories.data.expense.includes("שבת ברכות"),
      "שבע ברכות מפורטות ל-6 ימים בנפרד + 'שבת ברכות' כפריט נפרד, בדיוק כמו שהמשתמש ביקש"
    );

    const weddingDonation = await api("POST", "/api/wedding/transactions", { type: "income", amount: 3000, category: "תרומות", note: "דודה רחל" }, token);
    assert(weddingDonation.status === 201, "רישום תרומה לחתונה הצליח");
    const weddingHall = await api("POST", "/api/wedding/transactions", { type: "expense", amount: 20000, category: "אולם חתונה" }, token);
    assert(weddingHall.status === 201, "רישום הוצאת אולם חתונה הצליח");
    const weddingDress = await api("POST", "/api/wedding/transactions", { type: "expense", amount: 4000, category: "שמלת כלה" }, token);
    assert(weddingDress.status === 201, "רישום הוצאת שמלת כלה הצליח");

    const weddingList = await api("GET", "/api/wedding/transactions", null, token);
    assert(
      weddingList.data.summary.income === 3000 && weddingList.data.summary.expense === 24000 && weddingList.data.summary.balance === -21000,
      `הסיכום (תרומות מול הוצאות) חושב נכון (${JSON.stringify(weddingList.data.summary)})`
    );
    assert(weddingList.data.byCategory["אולם חתונה"] === 20000 && weddingList.data.byCategory["שמלת כלה"] === 4000, "פילוח הוצאות לפי קטגוריה נכון");

    const regularBalanceBefore = await api("GET", "/api/transactions", null, token);
    assert(
      !regularBalanceBefore.data.transactions.some(t => t.category === "אולם חתונה" || t.category === "תרומות"),
      "תנועות החתונה לא מופיעות בכלל בתנועות הרגילות (/api/transactions) - אזור נפרד לחלוטין, כמו שהתבקש"
    );

    console.log("\n💍 תקציב חתונה - קטגוריית 'אחר' חופשית נשמרת למילון נפרד");
    const weddingOtherExpense = await api("POST", "/api/wedding/transactions", { type: "expense", amount: 800, category: "צילום" }, token);
    assert(weddingOtherExpense.status === 201, "רישום הוצאת חתונה עם קטגוריה חופשית ('צילום', לא ברשימה הקבועה) הצליח");
    const weddingOtherDict = await api("GET", "/api/wedding/dictionary?type=expense", null, token);
    assert(weddingOtherDict.data.phrases.includes("צילום"), "קטגוריה חופשית שהוזנה בחתונה נשמרה למילון הנפרד שלה, תוצע שוב בפעם הבאה");
    const regularExpenseDict = await api("GET", "/api/transactions/dictionary?type=expense", null, token);
    assert(!regularExpenseDict.data.phrases.includes("צילום"), "המילון של החתונה נפרד לגמרי מהמילון של התנועות הרגילות - לא מתערבב");

    console.log("\n💍 תקציב חתונה - עריכת תנועה קיימת (לא רק מחיקה) - משוב אמיתי: 'שאוכל לערוך ולשנות'");
    const weddingEdit = await api("PUT", `/api/wedding/transactions/${weddingHall.data.transaction.id}`, { amount: 22000, note: "אולם + תוספת קייטרינג" }, token);
    assert(
      weddingEdit.status === 200 && weddingEdit.data.transaction.amount === 22000 && weddingEdit.data.transaction.category === "אולם חתונה",
      `עריכת סכום/הערה בתנועת חתונה קיימת הצליחה, בלי לאבד את הקטגוריה שלא נשלחה מחדש (${JSON.stringify(weddingEdit.data.transaction)})`
    );
    const weddingListAfterEdit = await api("GET", "/api/wedding/transactions", null, token);
    assert(weddingListAfterEdit.data.summary.expense === 26800, `הסיכום מתעדכן אחרי העריכה (20000→22000 + 4000 + 800 = 26800) (${weddingListAfterEdit.data.summary.expense})`);

    const otherUserWeddingSignup = await api("POST", "/api/auth/signup", {
      full_name: "משתמש זר לחתונה", username: `stranger_wedding_${Date.now()}`, password: "1234", phone: `+97250${Date.now().toString().slice(-7)}`,
    });
    const strangerWeddingEdit = await api("PUT", `/api/wedding/transactions/${weddingHall.data.transaction.id}`, { amount: 1 }, otherUserWeddingSignup.data.token);
    assert(strangerWeddingEdit.status === 404, "משתמש אחר לא יכול לערוך תנועת חתונה ששייכת למשתמש הזה");
    const strangerWeddingDelete = await api("DELETE", `/api/wedding/transactions/${weddingHall.data.transaction.id}`, null, otherUserWeddingSignup.data.token);
    assert(strangerWeddingDelete.status === 404, "משתמש אחר לא יכול למחוק תנועת חתונה ששייכת למשתמש הזה");

    const weddingDelete = await api("DELETE", `/api/wedding/transactions/${weddingDress.data.transaction.id}`, null, token);
    assert(weddingDelete.status === 200, "מחיקת תנועת חתונה (הבעלים האמיתי) הצליחה");
    const weddingListAfterDelete = await api("GET", "/api/wedding/transactions", null, token);
    assert(!weddingListAfterDelete.data.transactions.some(t => t.id === weddingDress.data.transaction.id), "התנועה שנמחקה אכן נעלמה מרשימת תנועות החתונה");

    console.log("\n🏠 תקציב דירה - אזור נפרד לגמרי (גם מהתנועות הרגילות וגם מ'חתונה')");
    // משוב אמיתי: "אני צריך שיהיה שני קטגוריות נפרדות: 1 חתונה, 2 דירה. בתוך דירה יש שני אפשרויות
    // רגיל, תבע משותף". ר' src/routes/apartmentTransactions.js - אותו דגם בדיוק כמו 'חתונה' למעלה.
    const apartmentCategories = await api("GET", "/api/apartment/categories", null, token);
    assert(
      apartmentCategories.status === 200 &&
      apartmentCategories.data.expense.includes("רגיל") &&
      apartmentCategories.data.expense.some(c => c.includes("תבע משותף") && c.includes("בנייה")) &&
      apartmentCategories.data.expense.some(c => c.includes("תבע משותף") && c.includes("מיסים")),
      `רשימת קטגוריות הדירה הקבועה כוללת 'רגיל' ואת תת-העלויות של 'תבע משותף' שהמשתמש ביקש (${JSON.stringify(apartmentCategories.data)})`
    );

    const apartmentRegular = await api("POST", "/api/apartment/transactions", { type: "expense", amount: 5000, category: "רגיל" }, token);
    assert(apartmentRegular.status === 201, "רישום הוצאת דירה 'רגיל' הצליח");
    const apartmentTama = await api("POST", "/api/apartment/transactions", { type: "expense", amount: 15000, category: "תבע משותף - עלות בנייה" }, token);
    assert(apartmentTama.status === 201, "רישום הוצאת דירה תחת 'תבע משותף' הצליח");

    const apartmentList = await api("GET", "/api/apartment/transactions", null, token);
    assert(
      apartmentList.data.summary.expense === 20000 && apartmentList.data.byCategory["רגיל"] === 5000 && apartmentList.data.byCategory["תבע משותף - עלות בנייה"] === 15000,
      `הסיכום ופילוח הקטגוריות של הדירה חושבו נכון (${JSON.stringify(apartmentList.data.summary)}, ${JSON.stringify(apartmentList.data.byCategory)})`
    );

    const regularAfterApartment = await api("GET", "/api/transactions", null, token);
    const weddingAfterApartment = await api("GET", "/api/wedding/transactions", null, token);
    assert(
      !regularAfterApartment.data.transactions.some(t => t.category === "רגיל" && t.amount === 5000) &&
      !weddingAfterApartment.data.transactions.some(t => t.category === "רגיל"),
      "תנועות הדירה לא מופיעות לא בתנועות הרגילות ולא בחתונה - שלושה אזורים נפרדים לגמרי"
    );

    const apartmentEdit = await api("PUT", `/api/apartment/transactions/${apartmentRegular.data.transaction.id}`, { amount: 5500 }, token);
    assert(apartmentEdit.status === 200 && apartmentEdit.data.transaction.amount === 5500, "עריכת תנועת דירה קיימת הצליחה (כמו בחתונה)");

    const otherUserApartmentSignup = await api("POST", "/api/auth/signup", {
      full_name: "משתמש זר לדירה", username: `stranger_apartment_${Date.now()}`, password: "1234", phone: `+97250${Date.now().toString().slice(-7)}`,
    });
    const strangerApartmentDelete = await api("DELETE", `/api/apartment/transactions/${apartmentTama.data.transaction.id}`, null, otherUserApartmentSignup.data.token);
    assert(strangerApartmentDelete.status === 404, "משתמש אחר לא יכול למחוק תנועת דירה ששייכת למשתמש הזה");
    const apartmentDelete = await api("DELETE", `/api/apartment/transactions/${apartmentTama.data.transaction.id}`, null, token);
    assert(apartmentDelete.status === 200, "מחיקת תנועת דירה (הבעלים האמיתי) הצליחה");

    console.log("\n📈 דוח חודשי (מגמה) לחתונה ולדירה - משוב אמיתי: 'אני רוצה גרף כמו בתנועות רגילות'");
    const weddingTrendCheck = await api("POST", "/api/wedding/transactions", { type: "income", amount: 500, category: "תרומות" }, token);
    const weddingTrend = await api("GET", "/api/wedding/transactions/trend", null, token);
    assert(weddingTrend.status === 200 && Array.isArray(weddingTrend.data.trend), `מגמה חודשית לחתונה זמינה (${JSON.stringify(weddingTrend.data)})`);
    const thisMonthWedding = weddingTrend.data.trend.find(m => m.income > 0);
    assert(thisMonthWedding && thisMonthWedding.income >= 500, "התרומה שנרשמה כרגע מופיעה בחודש הנוכחי במגמת החתונה");
    await api("DELETE", `/api/wedding/transactions/${weddingTrendCheck.data.transaction.id}`, null, token);

    const apartmentTrendCheck = await api("POST", "/api/apartment/transactions", { type: "expense", amount: 700, category: "רגיל" }, token);
    const apartmentTrend = await api("GET", "/api/apartment/transactions/trend", null, token);
    assert(apartmentTrend.status === 200 && Array.isArray(apartmentTrend.data.trend), `מגמה חודשית לדירה זמינה (${JSON.stringify(apartmentTrend.data)})`);
    const thisMonthApartment = apartmentTrend.data.trend.find(m => m.expense > 0);
    assert(thisMonthApartment && thisMonthApartment.expense >= 700, "ההוצאה שנרשמה כרגע מופיעה בחודש הנוכחי במגמת הדירה");
    await api("DELETE", `/api/apartment/transactions/${apartmentTrendCheck.data.transaction.id}`, null, token);

    console.log("\n📥 ייבוא קבצים לחתונה ולדירה - משוב אמיתי: 'גם בקטגוריה דירה וגם בחתונה אין אופציה של יבוא קבצים'");
    // אותו מנוע ייבוא בדיוק (src/routes/importTransactions.js) עם target=wedding|apartment - בודקים
    // ששני היעדים עובדים עצמאית, לא מתערבבים זה בזה ולא בתנועות הרגילות, ושהדדופ/מחיקת-קובץ-שלם
    // עובדים בנפרד על כל טבלה (ר' IMPORT_TARGETS).
    const weddingImportCsv = "תאריך,תיאור,סכום\n01/09/2026,תרומה מהמשפחה,1000\n02/09/2026,מקדמה לאולם,-5000\n";
    const weddingImportPreview = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: Buffer.from(weddingImportCsv, "utf8").toString("base64"), filename: "wedding-bank.csv", source_type: "bank", target: "wedding" },
      token
    );
    assert(weddingImportPreview.status === 200 && weddingImportPreview.data.transactions.length === 2, `תצוגה מקדימה של ייבוא לחתונה הצליחה (${JSON.stringify(weddingImportPreview.data)})`);
    const weddingImportCommit = await api(
      "POST", "/api/transactions/import/commit",
      { transactions: weddingImportPreview.data.transactions, filename: "wedding-bank.csv", target: "wedding" },
      token
    );
    assert(weddingImportCommit.status === 201 && weddingImportCommit.data.imported === 2, `שמירת הייבוא לחתונה הצליחה (${JSON.stringify(weddingImportCommit.data)})`);
    const weddingAfterImport = await api("GET", "/api/wedding/transactions", null, token);
    assert(
      weddingAfterImport.data.transactions.some(t => t.note === "תרומה מהמשפחה" && t.type === "income") &&
      weddingAfterImport.data.transactions.some(t => t.note === "מקדמה לאולם" && t.type === "expense"),
      "התנועות שיובאו לחתונה נשמרו בטבלת wedding_transactions עם התיאור המקורי"
    );
    const regularUnaffectedByWeddingImport = await api("GET", "/api/transactions", null, token);
    assert(
      !regularUnaffectedByWeddingImport.data.transactions.some(t => t.note === "תרומה מהמשפחה"),
      "ייבוא לחתונה לא דלף לתנועות הרגילות - יעד נפרד באמת"
    );

    const apartmentImportCsv = "תאריך,תיאור,סכום\n03/09/2026,מקדמה לדירה,-30000\n";
    const apartmentImportPreview = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: Buffer.from(apartmentImportCsv, "utf8").toString("base64"), filename: "apartment-bank.csv", source_type: "bank", target: "apartment" },
      token
    );
    const apartmentImportCommit = await api(
      "POST", "/api/transactions/import/commit",
      { transactions: apartmentImportPreview.data.transactions, filename: "apartment-bank.csv", target: "apartment" },
      token
    );
    assert(apartmentImportCommit.status === 201 && apartmentImportCommit.data.imported === 1, `שמירת הייבוא לדירה הצליחה (${JSON.stringify(apartmentImportCommit.data)})`);

    const weddingBatches = await api("GET", "/api/transactions/import/batches?target=wedding", null, token);
    assert(
      weddingBatches.data.batches.length === 1 && weddingBatches.data.batches[0].filename === "wedding-bank.csv" && weddingBatches.data.batches[0].count === 2,
      `רשימת קבצי ייבוא של החתונה מציגה רק את הקובץ שיובא לחתונה, לא לדירה (${JSON.stringify(weddingBatches.data)})`
    );
    const apartmentBatches = await api("GET", "/api/transactions/import/batches?target=apartment", null, token);
    assert(
      apartmentBatches.data.batches.length === 1 && apartmentBatches.data.batches[0].filename === "apartment-bank.csv",
      `רשימת קבצי ייבוא של הדירה מציגה רק את הקובץ שיובא לדירה, לא לחתונה (${JSON.stringify(apartmentBatches.data)})`
    );

    const weddingBatchDelete = await api("DELETE", `/api/transactions/import/batches/${weddingBatches.data.batches[0].batchId}?target=wedding`, null, token);
    assert(weddingBatchDelete.status === 200 && weddingBatchDelete.data.deleted === 2, `מחיקת קובץ הייבוא של החתונה מחקה בדיוק את שתי התנועות שלו (${JSON.stringify(weddingBatchDelete.data)})`);
    const apartmentBatchesAfterWeddingDelete = await api("GET", "/api/transactions/import/batches?target=apartment", null, token);
    assert(apartmentBatchesAfterWeddingDelete.data.batches.length === 1, "מחיקת קובץ הייבוא של החתונה לא נגעה בקובץ הייבוא של הדירה");

    console.log("\n💰 מעקב הלוואות בתשלומים - חישוב אוטומטי + קישור תנועות בפועל");
    // משוב אמיתי: "כל חודש כשאני מגיע לפנקס... שיהיה חישוב אוטומטי אם יש הלוואות בתשלומים כל חודש
    // שיתעדכן כמה תשלומים נשאר" - לשאלת הבהרה (רשומה ייעודית מול קישור לתנועות קיימות) המשתמש ענה
    // "גם וגם". ר' src/routes/loans.js.
    function monthsElapsedSinceStart(startDateStr) {
      const start = new Date(startDateStr + "T00:00:00");
      const now = new Date();
      let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
      if (now.getDate() < start.getDate()) months -= 1;
      return months + 1;
    }
    // תאריך התחלה 20 חודשים לפני היום (חודש עגול, יום 1) - כדי שהחישוב האוטומטי יהיה יציב וניתן
    // לחיזוי מדויק בבדיקה (לא תלוי היום-בחודש הנוכחי בפועל).
    const loanStart = new Date();
    loanStart.setMonth(loanStart.getMonth() - 20);
    loanStart.setDate(1);
    const loanStartStr = `${loanStart.getFullYear()}-${String(loanStart.getMonth() + 1).padStart(2, "0")}-01`;
    const expectedElapsed = Math.min(36, monthsElapsedSinceStart(loanStartStr));

    const loanCreate = await api("POST", "/api/loans", { name: "הלוואת רכב", total_installments: 36, monthly_amount: 1200, start_date: loanStartStr }, token);
    assert(loanCreate.status === 201, "יצירת הלוואה חדשה הצליחה");
    assert(
      loanCreate.data.loan.paidInstallments === expectedElapsed && loanCreate.data.loan.linkedPaymentsCount === 0,
      `לפני שקושרה אף תנועה, מספר התשלומים שבוצעו מוערך אוטומטית לפי חודשים שחלפו מתאריך ההתחלה (${JSON.stringify(loanCreate.data.loan)}, צפוי ${expectedElapsed})`
    );
    assert(
      loanCreate.data.loan.remainingInstallments === 36 - expectedElapsed,
      `נותרו = סה"כ תשלומים פחות מה שהוערך שבוצע (${loanCreate.data.loan.remainingInstallments})`
    );
    const loanId = loanCreate.data.loan.id;

    const loanList = await api("GET", "/api/loans", null, token);
    assert(loanList.status === 200 && loanList.data.loans.some(l => l.id === loanId), "רשימת ההלוואות כוללת את ההלוואה שנוצרה");

    // עכשיו מקשרים תנועת "הלוואות" אמיתית להלוואה - מהרגע הזה, המספר *האמיתי* של תשלומים שקושרו
    // גובר על ההערכה האוטומטית (לפי משוב "גם וגם" - מעדיפים מציאות על הערכה כשיש מציאות בפועל).
    const loanPayment = await api("POST", "/api/transactions", { type: "expense", amount: 1200, category: "הלוואות", loan_id: loanId }, token);
    assert(loanPayment.status === 201 && loanPayment.data.transaction.loan_id == loanId, "תנועת תשלום הלוואה נשמרה עם קישור להלוואה");
    const loanAfterPayment = await api("GET", "/api/loans", null, token);
    const loanRowAfterPayment = loanAfterPayment.data.loans.find(l => l.id === loanId);
    assert(
      loanRowAfterPayment.linkedPaymentsCount === 1 && loanRowAfterPayment.paidInstallments === 1 && loanRowAfterPayment.remainingInstallments === 35,
      `אחרי קישור תשלום אחד בפועל, המספר האמיתי (1) גובר על ההערכה האוטומטית (${expectedElapsed}) (${JSON.stringify(loanRowAfterPayment)})`
    );

    const loanEdit = await api("PUT", `/api/loans/${loanId}`, { total_installments: 24 }, token);
    assert(loanEdit.status === 200 && loanEdit.data.loan.total_installments === 24 && loanEdit.data.loan.remainingInstallments === 23, "עריכת מספר התשלומים הכולל של ההלוואה הצליחה ועדכנה את הנותרים");

    const otherUserLoanSignup = await api("POST", "/api/auth/signup", {
      full_name: "משתמש זר להלוואה", username: `stranger_loan_${Date.now()}`, password: "1234", phone: `+97250${Date.now().toString().slice(-7)}`,
    });
    const strangerLoanDelete = await api("DELETE", `/api/loans/${loanId}`, null, otherUserLoanSignup.data.token);
    assert(strangerLoanDelete.status === 404, "משתמש אחר לא יכול למחוק הלוואה ששייכת למשתמש הזה");

    const loanDelete = await api("DELETE", `/api/loans/${loanId}`, null, token);
    assert(loanDelete.status === 200, "מחיקת ההלוואה הצליחה");
    const paymentAfterLoanDelete = await api("GET", "/api/transactions", null, token);
    const paymentRow = paymentAfterLoanDelete.data.transactions.find(t => t.id === loanPayment.data.transaction.id);
    assert(paymentRow && paymentRow.loan_id === null, "מחיקת ההלוואה מנתקת את הקישור מהתנועה אבל לא מוחקת את התנועה עצמה");

    console.log("\n💰 ייבוא קובץ עם קישור להלוואה - משוב אמיתי: 'בהלוואות לא עשית שאני יכול לייבא נתונים'");
    const loanForImport = await api("POST", "/api/loans", { name: "הלוואת משכנתא", total_installments: 120, start_date: "2024-01-01" }, token);
    const loanForImportId = loanForImport.data.loan.id;
    const loanImportCsv = "תאריך,תיאור,סכום\n05/09/2026,הלוואה- פרעון,-1500\n06/09/2026,קניה בסופר,-200\n";
    const loanImportPreview = await api(
      "POST", "/api/transactions/import/parse",
      { data_base64: Buffer.from(loanImportCsv, "utf8").toString("base64"), filename: "loan-import.csv", source_type: "bank" },
      token
    );
    assert(loanImportPreview.status === 200 && loanImportPreview.data.transactions.length === 2, "תצוגה מקדימה של ייבוא לצורך קישור להלוואה הצליחה");
    // מקשרים רק את שורת "הלוואה- פרעון" להלוואה - השורה השנייה (קניה בסופר) לא קשורה לשום הלוואה.
    const loanImportRows = loanImportPreview.data.transactions.map(t => ({
      ...t,
      loan_id: t.description === "הלוואה- פרעון" ? loanForImportId : undefined,
    }));
    const loanImportCommit = await api("POST", "/api/transactions/import/commit", { transactions: loanImportRows, filename: "loan-import.csv" }, token);
    assert(loanImportCommit.status === 201 && loanImportCommit.data.imported === 2, `שמירת הייבוא עם קישור חלקי להלוואה הצליחה (${JSON.stringify(loanImportCommit.data)})`);
    const txsAfterLoanImport = await api("GET", "/api/transactions", null, token);
    const importedLoanTx = txsAfterLoanImport.data.transactions.find(t => t.note === "הלוואה- פרעון" && t.amount === 1500);
    const importedOtherTx = txsAfterLoanImport.data.transactions.find(t => t.note === "קניה בסופר");
    assert(importedLoanTx && importedLoanTx.loan_id == loanForImportId, "התנועה שסומנה בתצוגה המקדימה כשייכת להלוואה נשמרה עם הקישור הנכון");
    assert(importedOtherTx && !importedOtherTx.loan_id, "התנועה השנייה, שלא סומנה, יובאה בלי שום קישור להלוואה");
    const loanAfterImport = await api("GET", "/api/loans", null, token);
    const loanRowAfterImport = loanAfterImport.data.loans.find(l => l.id === loanForImportId);
    assert(loanRowAfterImport.linkedPaymentsCount === 1, `להלוואה מוצג עכשיו תשלום אחד אמיתי מהקובץ שיובא (${JSON.stringify(loanRowAfterImport)})`);

    console.log("\n📄 ייבוא לוח סילוקין הלוואה (PDF) - זיהוי אוטומטי של פרטי ההלוואה + קישור תשלומים שעברו");
    // משוב אמיתי: "צריך לדעת לקרוא גם קובץ [לוח סילוקין הלוואה]", ולשאלת הבהרה: "שניהם יחד - גם
    // רישום הלוואה וגם קישור תשלומים שעברו". ר' src/lib/pdfParser.js (parseLoanAmortizationPdf),
    // src/routes/loans.js (/parse-amortization, /commit-amortization). מדמה (buildTestPdf, לא הקובץ
    // האמיתי - לא נשמר בריפו) את המבנה המדויק שנצפה בקובץ אמיתי (מזרחי-טפחות): הכותרת מתפצלת על
    // פני *שלוש* שורות פיזיות (לא שתיים) - "מספר"/"תשלום","תאריך"/"חיוב" וכו' על שתי שורות, אבל
    // "יתרת הקרן" בלי פיצול, כשורה שלישית שיושבת (לפי y) *בין* שתי שורות ההמשך של שאר העמודות.
    const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [yy, mm, dd] = yesterdayIso.split("-");
    const pastPaymentDate = `${dd}/${mm}/${yy.slice(2)}`; // dd/mm/yy - כמו בקובץ האמיתי
    const amortPdf = buildTestPdf([
      // בלוק הכותרת - שלוש שורות פיזיות, אותם מיקומי x/y בדיוק כמו שנצפו בקובץ האמיתי
      { text: "מספר", x: 504.0, y: 766.2 }, { text: "תאריך", x: 442.5, y: 766.2 },
      { text: "תשלום על חשבון", x: 330.4, y: 766.2 }, { text: "תשלום על חשבון", x: 231.6, y: 766.2 },
      { text: "סך החזר", x: 165.2, y: 766.2 },
      { text: "יתרת הקרן", x: 88.3, y: 758.0 },
      { text: "תשלום", x: 498.5, y: 749.7 }, { text: "חיוב", x: 451.6, y: 749.7 },
      { text: "הקרן", x: 387.2, y: 749.7 }, { text: "הריבית", x: 278.7, y: 749.7 }, { text: "חודשי", x: 177.4, y: 749.7 },
      // שורת תשלום 1 - תאריך עבר (אתמול) - צריכה להיקשר כתנועה בפועל
      { text: "1", x: 523.8, y: 717.4 }, { text: pastPaymentDate, x: 420.9, y: 717.4 },
      { text: "368.88", x: 372.3, y: 717.4 }, { text: "406.77", x: 273.6, y: 717.4 },
      { text: "775.65", x: 167.5, y: 717.4 }, { text: "74,631.12", x: 83.4, y: 717.4 },
      // שורת תשלום 2 - תאריך עתידי - לא אמורה להיקשר (משוב אמיתי מדגיש רק "תשלומים שעברו")
      { text: "2", x: 523.8, y: 685.2 }, { text: "22/09/40", x: 420.9, y: 685.2 },
      { text: "352.75", x: 372.3, y: 685.2 }, { text: "359.16", x: 273.6, y: 685.2 },
      { text: "711.91", x: 167.5, y: 685.2 }, { text: "74,278.37", x: 83.4, y: 685.2 },
    ]);
    const amortParse = await api(
      "POST", "/api/loans/parse-amortization",
      { data_base64: amortPdf.toString("base64"), filename: "loan-amort-test.pdf" },
      token
    );
    assert(
      amortParse.status === 200 && amortParse.data.totalInstallments === 2 && amortParse.data.startDate === yesterdayIso,
      `לוח סילוקין עם כותרת מתפצלת על שלוש שורות פיזיות זוהה נכון - 2 תשלומים, תאריך התחלה נכון (${JSON.stringify(amortParse.data)})`
    );
    assert(
      amortParse.data.payments[0].isPast === true && amortParse.data.payments[1].isPast === false,
      "תשלום עם תאריך שעבר מסומן isPast, ותשלום עתידי לא"
    );
    assert(
      amortParse.data.payments[0].principal === 368.88 && amortParse.data.payments[0].interest === 406.77 &&
      amortParse.data.payments[0].totalPayment === 775.65 && amortParse.data.payments[0].remainingBalance === 74631.12,
      `כל שדות התשלום הראשון זוהו נכון מתוך שש העמודות (קרן/ריבית/סה"כ/יתרה) (${JSON.stringify(amortParse.data.payments[0])})`
    );

    const amortCommit = await api(
      "POST", "/api/loans/commit-amortization",
      {
        name: amortParse.data.suggestedName, total_installments: amortParse.data.totalInstallments,
        start_date: amortParse.data.startDate, monthly_amount: amortParse.data.monthlyAmount,
        payments: amortParse.data.payments.map(p => ({ ...p, included: p.isPast })),
      },
      token
    );
    assert(
      amortCommit.status === 201 && amortCommit.data.linkedPayments === 1,
      `יצירת ההלוואה + קישור תשלום אחד שעבר (לא השני, עתידי) הצליחה (${JSON.stringify(amortCommit.data)})`
    );
    const amortLoanId = amortCommit.data.loan.id;
    assert(
      amortCommit.data.loan.linkedPaymentsCount === 1 && amortCommit.data.loan.remainingInstallments === 1,
      `ההלוואה שנוצרה מציגה תשלום אחד מקושר בפועל ותשלום אחד שנותר (${JSON.stringify(amortCommit.data.loan)})`
    );
    const txsAfterAmort = await api("GET", "/api/transactions", null, token);
    const amortLinkedTx = txsAfterAmort.data.transactions.find(t => t.loan_id === amortLoanId);
    assert(
      amortLinkedTx && amortLinkedTx.amount === 775.65 && amortLinkedTx.occurred_at.startsWith(yesterdayIso),
      `התשלום שעבר נשמר כתנועה רגילה מקושרת להלוואה, עם הסכום והתאריך הנכונים מהלוח (${JSON.stringify(amortLinkedTx)})`
    );

    // ניקוי
    await api("DELETE", `/api/transactions/${amortLinkedTx.id}`, null, token);
    await api("DELETE", `/api/loans/${amortLoanId}`, null, token);

    console.log("\n🔗 מיזוג הלוואות כפולות - משוב אמיתי: 'הכנסתי שלושה קבצים שהם מהלוואה אחת, המערכת חישבה את זה כשלושה, אפשר למזג'");
    // מדמים בדיוק את התרחיש שדווח: אותו לוח סילוקין מיובא (ומאושר/נשמר) שלוש פעמים נפרדות - כמו
    // שקורה כשמורידים/מעלים כמה ייצואים שונים של אותה הלוואה - כל ייבוא יוצר הלוואה נפרדת משלו.
    const dupLoanIds = [];
    for (let i = 0; i < 3; i++) {
      const p = await api(
        "POST", "/api/loans/parse-amortization",
        { data_base64: amortPdf.toString("base64"), filename: `loan-amort-dup-${i}.pdf` },
        token
      );
      const c = await api(
        "POST", "/api/loans/commit-amortization",
        {
          name: `${p.data.suggestedName} ${i}`, total_installments: p.data.totalInstallments,
          start_date: p.data.startDate, monthly_amount: p.data.monthlyAmount,
          payments: p.data.payments.map(pay => ({ ...pay, included: pay.isPast })),
        },
        token
      );
      dupLoanIds.push(c.data.loan.id);
    }
    const txsBeforeMerge = await api("GET", "/api/transactions", null, token);
    const linkedBeforeMerge = txsBeforeMerge.data.transactions.filter(t => dupLoanIds.includes(t.loan_id));
    assert(linkedBeforeMerge.length === 3, `לפני המיזוג - שלוש תנועות זהות (אחת לכל ייבוא כפול) (${linkedBeforeMerge.length})`);

    const mergeResult = await api("POST", "/api/loans/merge", { target_id: dupLoanIds[0], source_ids: [dupLoanIds[1], dupLoanIds[2]] }, token);
    assert(
      mergeResult.status === 200 && mergeResult.data.mergedLoans === 2 && mergeResult.data.deletedDuplicateTransactions === 2,
      `המיזוג הצליח - 2 הלוואות מוזגו, ו-2 תנועות כפולות (אותו תאריך+סכום) נמחקו אוטומטית (${JSON.stringify(mergeResult.data)})`
    );
    assert(mergeResult.data.loan.linkedPaymentsCount === 1, "אחרי המיזוג נשארה תנועה אחת בלבד מקושרת להלוואה הראשית - לא שלוש");

    const loansAfterMerge = await api("GET", "/api/loans", null, token);
    assert(
      !loansAfterMerge.data.loans.some(l => l.id === dupLoanIds[1] || l.id === dupLoanIds[2]) &&
      loansAfterMerge.data.loans.some(l => l.id === dupLoanIds[0]),
      "ההלוואות שמוזגו (המקור) נמחקו, ורק הראשית נשארה"
    );
    const txsAfterMerge = await api("GET", "/api/transactions", null, token);
    const linkedAfterMerge = txsAfterMerge.data.transactions.filter(t => t.loan_id === dupLoanIds[0]);
    assert(linkedAfterMerge.length === 1, `אחרי המיזוג - תנועה אחת בלבד מקושרת בפועל להלוואה הראשית (${linkedAfterMerge.length})`);

    // ניקוי
    await api("DELETE", `/api/transactions/${linkedAfterMerge[0].id}`, null, token);
    await api("DELETE", `/api/loans/${dupLoanIds[0]}`, null, token);

    console.log("\n💳 תשלומים חוזרים (כרטיסי אשראי/הו\"ק) + התראה לפני תאריך החיוב");
    // משוב אמיתי: "יש לאנשים כרטיסי אשראי שכל כרטיס יוצא בתאריך אחר או הו\"ק בבנק, חשוב לי שיקבל
    // התראה לפני התאריך כמה כסף צריך להכניס לבנק". ר' src/routes/recurringCharges.js.
    const { nextChargeDate: rcNextChargeDate } = require("../src/routes/recurringCharges");

    // --- חישוב תאריך החיוב הבא (פונקציית תאריכים טהורה, בלי API) ---
    const jan15 = new Date(Date.UTC(2026, 0, 15));
    assert(
      rcNextChargeDate(20, jan15).getTime() === Date.UTC(2026, 0, 20),
      "אם יום החיוב עוד לא הגיע החודש, החיוב הבא הוא באותו חודש"
    );
    assert(
      rcNextChargeDate(10, jan15).getTime() === Date.UTC(2026, 1, 10),
      "אם יום החיוב כבר עבר החודש, החיוב הבא קופץ לחודש הבא"
    );
    assert(
      rcNextChargeDate(15, jan15).getTime() === Date.UTC(2026, 0, 15),
      "אם היום עצמו הוא יום החיוב, נחשב 'החיוב הבא' (לא קופץ קדימה)"
    );
    // מ-1 בפברואר (אחרי שה-31 בינואר כבר עבר) - החיוב הבא ליום "31" צריך להיות פברואר 2026 (לא
    // מעוברת, 28 ימים בלבד) - נצמד ליום האחרון בפועל של החודש, לא גולש למרץ.
    const feb1 = new Date(Date.UTC(2026, 1, 1));
    assert(
      rcNextChargeDate(31, feb1).getTime() === Date.UTC(2026, 1, 28),
      `יום חיוב 31 בחודש שאין בו 31 (פברואר 2026, לא מעוברת) נצמד ליום האחרון בפועל (${new Date(rcNextChargeDate(31, feb1)).toISOString()})`
    );

    // --- CRUD + הערכת סכום אוטומטית מהקטגוריה המקושרת (ממוצע, לא הזנה ידנית) ---
    await api("POST", "/api/transactions", { type: "expense", amount: 300, category: "כרטיס בדיקה" }, token);
    await api("POST", "/api/transactions", { type: "expense", amount: 340, category: "כרטיס בדיקה" }, token);
    await api("POST", "/api/transactions", { type: "expense", amount: 320, category: "כרטיס בדיקה" }, token);

    const rcCreate = await api("POST", "/api/recurring-charges", { name: "כרטיס בדיקה", charge_day: 10, category: "כרטיס בדיקה" }, token);
    assert(rcCreate.status === 201, `יצירת מחויב חוזר חדש הצליחה (${JSON.stringify(rcCreate.data)})`);
    assert(
      rcCreate.data.charge.estimatedFromCount === 3 && rcCreate.data.charge.estimatedAmount === 320,
      `הסכום המוערך מחושב אוטומטית כממוצע 3 התנועות האחרונות בקטגוריה, לא הוזן ידנית (320 = (300+340+320)/3) (${JSON.stringify(rcCreate.data.charge)})`
    );
    const rcId = rcCreate.data.charge.id;

    const rcNoCategory = await api("POST", "/api/recurring-charges", { name: "בלי קטגוריה מקושרת", charge_day: 5 }, token);
    assert(
      rcNoCategory.status === 201 && rcNoCategory.data.charge.estimatedFromCount === 0 && rcNoCategory.data.charge.estimatedAmount === null,
      "מחויב בלי קטגוריה מקושרת מוצג בלי סכום מוערך (null, לא 0 מטעה)"
    );

    const rcList = await api("GET", "/api/recurring-charges", null, token);
    assert(rcList.status === 200 && rcList.data.charges.some(c => c.id === rcId), "רשימת המחויבים החוזרים כוללת את מה שנוצר");

    const rcEdit = await api("PUT", `/api/recurring-charges/${rcId}`, { charge_day: 15, reminder_days_before: 5 }, token);
    assert(
      rcEdit.status === 200 && rcEdit.data.charge.charge_day === 15 && rcEdit.data.charge.reminder_days_before === 5,
      "עריכת יום החיוב וימי ההתראה מראש הצליחה"
    );

    const otherUserRcSignup = await api("POST", "/api/auth/signup", {
      full_name: "משתמש זר למחויב", username: `stranger_rc_${Date.now()}`, password: "1234", phone: `+97250${Date.now().toString().slice(-7)}`,
    });
    const strangerRcDelete = await api("DELETE", `/api/recurring-charges/${rcId}`, null, otherUserRcSignup.data.token);
    assert(strangerRcDelete.status === 404, "משתמש אחר לא יכול למחוק מחויב חוזר ששייך למשתמש הזה");

    // --- נתיב הרצת ההתראות היומי - מוגן ב-key קבוע (Render Cron Job חיצוני), לא JWT רגיל ---
    const cronNoKey = await api("GET", "/api/system/charge-reminders/run", null, token);
    assert(cronNoKey.status === 403, "נתיב הרצת ההתראות היומי דורש key נכון בפרמטר - לא נתיב מוגן ב-JWT רגיל");
    const cronWithKey = await api("GET", "/api/system/charge-reminders/run?key=hapinkas-charges-cron-5817", null, token);
    assert(
      cronWithKey.status === 200 && typeof cronWithKey.data.checked === "number" && typeof cronWithKey.data.remindersSent === "number",
      `עם key נכון, נתיב ה-cron רץ על כל המשתמשים ומחזיר סיכום (${JSON.stringify(cronWithKey.data)})`
    );

    // ניקוי - לא משפיע על בדיקות אחרות (סכומי התנועות הרגילות נבדקים תמיד באופן דינמי, לא מול
    // ערך קבוע מראש - ר' הערה דומה בבדיקות ההעברה למעלה), אבל מנקים בכל זאת לניקיון.
    await api("DELETE", `/api/recurring-charges/${rcId}`, null, token);
    await api("DELETE", `/api/recurring-charges/${rcNoCategory.data.charge.id}`, null, token);

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
      full_name: "משתמש זר מוקדם", username: `stranger0_${Date.now()}`, password: "1234", phone: "+972500000095",
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
      full_name: "הורה לדוגמה", username: `parent_${Date.now()}`, password: "1234", email: "parent@example.com", phone: "+972500000096",
    });
    const parentToken = parentSignup.data.token;
    const parentUsername = parentSignup.data.user.username;

    const strangerSignup = await api("POST", "/api/auth/signup", {
      full_name: "משתמש זר", username: `stranger_${Date.now()}`, password: "1234", phone: "+972500000097",
    });
    const strangerToken = strangerSignup.data.token;

    const addGuardianByStranger = await api("POST", `/api/students/${sid}/guardians`, { username: parentUsername }, strangerToken);
    assert(addGuardianByStranger.status === 403, "משתמש זר בלי תפקיד מקצועי (roles='private' בלבד) לא יכול לשייך הורה לתלמיד - כולל הורה שמנסה לשייך את עצמו");

    const otherProfessionalSignup = await api("POST", "/api/auth/signup", {
      full_name: "מטפל אחר בצוות", username: `other_pro_${Date.now()}`, password: "1234", roles: "therapist", phone: "+972500000098",
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

    // תוקן (משוב אמיתי ממשתמש בבדיקה חיה): "אמרתי 100 ש"ח והוא לא זיהה" - שני תיקונים: (1) סכומים
    // עברו ל-FREE_TEXT_STATES בימות (ר' routes/yemot.js) כדי לעבור דרך Whisper במקום מנוע הזיהוי
    // המובנה החלש יותר; (2) רשת ביטחון נוספת - extractAmount מפענח גם מספר שנאמר במילים ("מאה"),
    // לא רק ספרות ("100"), למקרה שהתמלול (בכל מנוע) כותב את המספר במילים ולא בספרות.
    console.log("\n🔢 סכום שנאמר במילים בעברית (למשל 'מאה שקלים', לא רק ספרות) גם מזוהה נכון");
    const wordAmountCallSid = `${callSid}-word-amount`;
    await ivrCall(wordAmountCallSid, "+972500000001");
    await ivrSay(wordAmountCallSid, "הוצאה");
    const wordAmountEcho = await ivrSay(wordAmountCallSid, "מאה שקלים");
    assert(wordAmountEcho.includes("רשמתי 100 שקלים"), "סכום שנאמר לגמרי במילים ('מאה שקלים', בלי אף ספרה) מזוהה נכון כ-100");
    // "אחר" כמילה בודדת כבר לא הופך להיות שם הקטגוריה המילולי - מבקשים לתאר בקול חופשי (ר' הבדיקה
    // הייעודית למטה, "קטגוריית הוצאה מותאמת-אישית"), אז כאן פשוט אומרים קטגוריה רגילה כדי להמשיך.
    await ivrSay(wordAmountCallSid, "מזון");
    await ivrSay(wordAmountCallSid, "כן");
    const afterWordAmountTx = await api("GET", "/api/transactions", null, token);
    assert(
      afterWordAmountTx.data.transactions.some(t => t.source === "phone" && t.amount === 100 && t.category === "מזון"),
      "התנועה שסכומה זוהה ממילים (לא ספרות) אכן נשמרה במסד הנתונים עם הסכום הנכון"
    );

    const balanceCallSid = `${callSid}-balance`;
    await ivrCall(balanceCallSid, "+972500000001");
    const balanceXml = await ivrSay(balanceCallSid, "ניהול חשבונות");
    assert(balanceXml.includes("היתרה הנוכחית שלך היא"), "קטגוריית 'ניהול חשבונות' מקריאה את היתרה");
    assert(
      balanceXml.includes("רוצים להוסיף הכנסה או הוצאה") && balanceXml.includes("1 להכנסה"),
      "מיד אחרי קריאת היתרה מוצעת הוספת הכנסה/הוצאה (בדיוק כמו באתר), עם קיצור הקשה ייעודי (1=הכנסה, 2=הוצאה)"
    );
    // משוב אמיתי ממשתמש: "ששומעים מן היתרה... שיאמר מה סכום הכנסה ומה סכום הוצאות וחובת מעשרות"
    assert(
      balanceXml.includes("סך ההכנסות") && balanceXml.includes("סך ההוצאות") && balanceXml.includes("חובת המעשר שלך היא"),
      "קריאת היתרה כוללת גם את סך ההכנסות, סך ההוצאות, וחובת המעשר - לא רק את היתרה הסופית"
    );
    const balanceSummary = await api("GET", "/api/transactions", null, token);
    assert(
      balanceXml.includes(`סך ההכנסות: ${balanceSummary.data.summary.income} שקלים`) &&
      balanceXml.includes(`סך ההוצאות: ${balanceSummary.data.summary.expense} שקלים`) &&
      balanceXml.includes(`חובת המעשר שלך היא ${balanceSummary.data.tithe.obligation} שקלים`),
      "הסכומים שמוקראים בטלפון (הכנסות/הוצאות/חובת מעשר) תואמים בדיוק למה שמחושב ומוצג באתר (GET /api/transactions)"
    );
    const balanceIncomeAmount = await ivrSay(balanceCallSid, "הכנסה");
    assert(balanceIncomeAmount.includes("מה סכום ההכנסה"), "אמירת 'הכנסה' מיד אחרי היתרה עוברת ישר לזרימת הוספת הכנסה, בלי לחזור לתפריט הראשי הכללי");

    const txCallSid = `${callSid}-transactions`;
    await ivrCall(txCallSid, "+972500000001");
    const txMenu = await ivrSay(txCallSid, "תנועות");
    assert(txMenu.includes("הכנסה") && txMenu.includes("הוצאה") && txMenu.includes("מעשרות"), "קטגוריית 'תנועות' פותחת תת-תפריט הכנסה/הוצאה/מעשרות");
    await ivrSay(txCallSid, "הכנסה");
    const txIncomeCategory = await ivrSay(txCallSid, "300");
    assert(txIncomeCategory.includes("מאיזה מקור ההכנסה"), "אחרי סכום ההכנסה נשאלת קטגוריית מקור ההכנסה");
    const txIncomeConfirm = await ivrSay(txCallSid, "משכורת");
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
    // תוקן (משוב אמיתי ממשתמש): בעבר, אחרי הכתבת השם עוד ביקשנו אישור נפרד ("לאשר: נרשמים בשם X...
    // אמרו כן") לפני שממשיכים - צעד כפול ומיותר. עכשיו ממשיכים ישר מהשם לקוד PIN, בלי שאלת אישור
    // נפרדת - עדיין "חוזרים" על השם בתחילת המשפט הבא כדי שיהיה ברור מיד מה נקלט.
    const signupPinPrompt = await ivrSay(signupCallSid, "רותם כהן");
    assert(
      signupPinPrompt.includes("רותם כהן") && signupPinPrompt.includes("קוד סודי") && signupPinPrompt.includes('input="dtmf"') && signupPinPrompt.includes('numDigits="4"'),
      "מיד אחרי הכתבת השם, בלי שאלת אישור נפרדת, המערכת חוזרת על השם ומבקשת קוד PIN בן 4 ספרות בהקשה (DTMF)"
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
    // תוקן (משוב אמיתי: "צריך לקצר... רק לומר מומלץ להוסיף מייל באתר ולהמשיך, בלי הקשות") - שלב
    // הכתבת המייל בטלפון הוסר לגמרי: אחרי הקשה כפולה תואמת של ה-PIN, ההרשמה מסתיימת מיד, עם משפט
    // מידע קצר במקום שאלה אינטראקטיבית.
    const signupDoneXml = await ivrSay(signupCallSid, "1234");
    assert(
      signupDoneXml.includes("הוגדר בהצלחה") && signupDoneXml.includes("מומלץ להוסיף כתובת מייל") && signupDoneXml.includes("נא לציין"),
      "אחרי הקשה כפולה תואמת של קוד ה-PIN, ההרשמה מסתיימת מיד - משפט מידע קצר על מייל באתר (לא שאלה), וישר לתפריט הרגיל"
    );

    const signupPinLogin = await api("POST", "/api/auth/login", { username: `phone_${signupPhone.replace(/\D/g, "").slice(-9)}`, password: "1234" });
    assert(signupPinLogin.status === 200 && signupPinLogin.data.token, "קוד ה-PIN שהוקש בטלפון בהרשמה עובד גם כסיסמה להתחברות באתר");

    const secondCallSameNumber = await ivrCall(`${signupCallSid}-again`, signupPhone);
    assert(
      secondCallSameNumber.includes("רותם כהן") && !secondCallSameNumber.includes("אינו מזוהה"),
      "שיחה חוזרת מאותו מספר אחרי ההרשמה כבר מזהה את המשתמש (בלי הצעת הרשמה נוספת)"
    );

    console.log("\n☎️ מנוע השיחה הקולית מול ימות המשיח (שלוחת API) — אותה מכונת מצבים, פרוטוקול שונה");
    const ymCallId = `YM-${Date.now()}`;
    const ymGreeting = await yemotCall({ callId: ymCallId, phone: "0500000001" });
    assert(ymGreeting.startsWith("read=t-") && ymGreeting.includes("נא לציין"), "פתיחת שיחה בימות (מספר בפורמט מקומי) מזהה משתמש ומציגה תפריט קטגוריות");
    assert(ymGreeting.includes("שלום וברכה") && ymGreeting.includes("הגעתם לקו הפנקס שלי"), "מיד כשמתקשרים גם בימות המערכת פותחת בברכה 'שלום וברכה, הגעתם לקו הפנקס שלי' לפני שאר התפריט");
    // תוקן (משוב אמיתי ממשתמש: "המערכת שואלת... או להקיש 1 עד 7 - זה לא טוב, צריך לומר אפשר גם
    // להקיש ניהול חשבונות 1, תנועות הקישו 2, וכן הלאה") - כל קטגוריה מקבלת את מספר ההקשה שלה מיד
    // אחריה, לא רשימה כללית "1 עד 7" נפרדת בסוף שלא ברור איזו ספרה שייכת לאיזו קטגוריה.
    assert(
      ymGreeting.includes("ניהול חשבונות הקישו 1") && ymGreeting.includes("מעשרות הקישו 7") && !ymGreeting.includes("1 עד 7") && !ymGreeting.includes("סולמית"),
      "כבר בברכת הפתיחה בימות כל קטגוריה מקבלת את מספר ההקשה שלה מיד אחריה ('ניהול חשבונות הקישו 1', ... 'מעשרות הקישו 7') - לא הערה כללית מנותקת '1 עד 7' בסוף. " +
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
    await yemotCall({ callId: ymCallId, speech: "1" }); // 1 = מזון (תפריט קטגוריות בהקשה, ר' EXPENSE_CATEGORY_DIGITS)
    const ymConfirm = await yemotCall({ callId: ymCallId, speech: "כן" });
    assert(
      ymConfirm.includes("נשמר") && ymConfirm.includes("רוצים עוד הוצאה") && ymConfirm.includes("לסיים? הקישו 3") && !ymConfirm.includes("g-hangup"),
      "זרימת הוצאה קולית מלאה דרך ימות הושלמה ואושרה, וחוזרת עם תפריט המשך ממוקד (עוד הוצאה/לעבור להכנסה/לסיים), לא מנתקת מיד"
    );

    const afterYmTx = await api("GET", "/api/transactions", null, token);
    const ymTx = afterYmTx.data.transactions.find(t => t.source === "phone" && t.amount === 45 && t.category === "מזון");
    assert(!!ymTx, "התנועה שנוצרה בשיחת ימות אכן נשמרה במסד הנתונים עם source=phone");

    // תוקן (משוב אמיתי ממשתמש בבדיקה חיה - "אמרתי 100 ש"ח והוא לא זיהה"): גם בימות, סכום עם סימן
    // ש"ח/מילים נלוות מזוהה נכון (ה-regex לספרות כבר מתעלם מטקסט נוסף סביב הספרות עצמן).
    const ymAmountWithCurrencyCallId = `${ymCallId}-amount-currency`;
    await yemotCall({ callId: ymAmountWithCurrencyCallId, phone: "0500000001" });
    await yemotCall({ callId: ymAmountWithCurrencyCallId, speech: "הכנסה" });
    const ymAmountCategoryPrompt = await yemotCall({ callId: ymAmountWithCurrencyCallId, speech: '100 ש"ח' });
    assert(ymAmountCategoryPrompt.includes("מאיזה מקור ההכנסה"), "בימות, סכום עם 'ש\"ח' צמוד לספרות עדיין מזוהה נכון כ-100 וממשיך ישר לשאלת מקור ההכנסה");
    const ymAmountEcho = await yemotCall({ callId: ymAmountWithCurrencyCallId, speech: "1" }); // 1 = משכורת
    assert(ymAmountEcho.includes("לאשר: הכנסה של 100 שקלים"), "בימות, סכום עם 'ש\"ח' צמוד לספרות (לא רק ספרה נקייה) עדיין מזוהה נכון כ-100");

    console.log("\n❓ קלט לא ברור בשאלת אישור לא מבטל בשקט (רק 'לא' מפורש מבטל) - כדי לא לאבד תנועה שהוזנה");
    // בבדיקה בפועל מול ימות התברר שמילים כמו "אישור"/"לאשר" לפעמים לא מזוהות בדיוק ע"י זיהוי הדיבור.
    // בעבר כל קלט שלא זוהה כ"כן" נחשב אוטומטית "לא" וביטל את כל התנועה בשקט - התנהגות מסוכנת.
    const ymUnclearCallId = `${ymCallId}-unclear-confirm`;
    await yemotCall({ callId: ymUnclearCallId, phone: "0500000001" });
    await yemotCall({ callId: ymUnclearCallId, speech: "הוצאה" });
    await yemotCall({ callId: ymUnclearCallId, speech: "63" });
    await yemotCall({ callId: ymUnclearCallId, speech: "1" }); // 1 = מזון
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
    assert(
      ymUnclearThenYes.includes("נשמר") && ymUnclearThenYes.includes("רוצים עוד הוצאה"),
      "אחרי הקלט הלא ברור, אמירת 'כן' עדיין שומרת את התנועה כרגיל"
    );
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
    const ymDigitCategoryPrompt = await yemotCall({ callId: ymDigitCallId, speech: "77" });
    assert(ymDigitCategoryPrompt.includes("מאיזה מקור ההכנסה"), "אחרי הסכום שואלים על מקור ההכנסה בהקשה");
    const ymDigitConfirmPrompt = await yemotCall({ callId: ymDigitCallId, speech: "1" }); // 1 = משכורת
    assert(ymDigitConfirmPrompt.includes("הקישו 1"), "שאלת האישור בימות מזכירה אפשרות הקשת 1 לאישור מהיר");
    const ymDigitConfirmDone = await yemotCall({ callId: ymDigitCallId, speech: "1" });
    assert(
      ymDigitConfirmDone.includes("נשמר") && ymDigitConfirmDone.includes("רוצים עוד הכנסה"),
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
    await yemotCall({ callId: ymHashConfirmCallId, speech: "1" }); // 1 = משכורת
    const ymHashConfirmDone = await yemotCall({ callId: ymHashConfirmCallId, speech: "#" });
    assert(
      ymHashConfirmDone.includes("נשמר") && ymHashConfirmDone.includes("רוצים עוד הכנסה"),
      "סולמית בודדת עדיין מתקבלת כאישור תקף אם היא כן מגיעה לשרת (גיבוי נוסף, גם אם לא מוצע יותר למתקשר)"
    );

    const ymBalanceCallId = `${ymCallId}-balance`;
    await yemotCall({ callId: ymBalanceCallId, phone: "+972500000001" }); // מוודאים שפורמט בינלאומי (+972) גם מזוהה
    const ymBalance = await yemotCall({ callId: ymBalanceCallId, speech: "חשבונות" });
    assert(ymBalance.includes("היתרה הנוכחית שלך היא"), "קטגוריית 'ניהול חשבונות' (מילה 'חשבונות') עובדת גם דרך ימות");
    assert(
      ymBalance.includes("רוצים להוסיף הכנסה או הוצאה") && !ymBalance.includes("g-hangup"),
      "אחרי שמיעת היתרה לא מנתקים מיד - שואלים במפורש אם להוסיף הכנסה/הוצאה (בדיוק כמו באתר), עם קיצור הקשה ייעודי"
    );
    assert(
      ymBalance.includes("סך ההכנסות") && ymBalance.includes("סך ההוצאות") && ymBalance.includes("חובת המעשר שלך היא"),
      "קריאת היתרה דרך ימות כוללת גם היא את סך ההכנסות, סך ההוצאות, וחובת המעשר"
    );

    console.log("\n🔁 כמה פעולות באותה שיחה, ואז סיום בנימוס מהתפריט הראשי");
    // זו בדיוק היכולת החדשה: אחרי פעולה ראשונה (יתרה) לא מנתקים - אפשר להמשיך ישר לפעולה שנייה
    // (הוצאה) באותה שיחה בדיוק, ורק בסוף לבקש לסיים במפורש מהתפריט הראשי.
    const ymMultiCallId = `${ymCallId}-multi-action`;
    await yemotCall({ callId: ymMultiCallId, phone: "0500000001" });
    const ymMultiBalance = await yemotCall({ callId: ymMultiCallId, speech: "חשבונות" });
    assert(ymMultiBalance.includes("רוצים להוסיף הכנסה או הוצאה"), "אחרי היתרה מוצעת אפשרות להמשיך ישר להוספת הכנסה/הוצאה באותה שיחה");
    await yemotCall({ callId: ymMultiCallId, speech: "הוצאה" });
    await yemotCall({ callId: ymMultiCallId, speech: "33" });
    await yemotCall({ callId: ymMultiCallId, speech: "6" }); // 6 = ביגוד
    const ymMultiExpenseDone = await yemotCall({ callId: ymMultiCallId, speech: "כן" });
    assert(
      ymMultiExpenseDone.includes("נשמר") && ymMultiExpenseDone.includes("רוצים עוד הוצאה"),
      "פעולה שנייה (הוצאה) הושלמה בהצלחה באותה שיחה בדיוק, בלי שהשיחה נותקה בין לבין"
    );
    const ymMultiFinish = await yemotCall({ callId: ymMultiCallId, speech: "3" }); // 3 = לסיים (בתפריט ההמשך הממוקד)
    assert(
      ymMultiFinish.includes("להתראות") && ymMultiFinish.includes("g-hangup"),
      "הקשת 3 (לסיים) בתפריט ההמשך אחרי שמירת תנועה מסיימת את השיחה בנימוס ומנתקת בפועל"
    );
    const afterMulti = await api("GET", "/api/transactions", null, token);
    assert(
      afterMulti.data.transactions.some(t => t.source === "phone" && t.amount === 33 && t.category === "ביגוד"),
      "התנועה שנוספה כפעולה שנייה באותה שיחה אכן נשמרה במסד הנתונים"
    );

    console.log("\n#️⃣ קיצורי הקשה (DTMF) בתפריט - במקום לדבר, ובלי לחכות שהמערכת תסיים להקריא");
    const ymDigitMenuCallId = `${ymCallId}-digit-menu`;
    await yemotCall({ callId: ymDigitMenuCallId, phone: "0500000001" });
    const ymDigitBalance = await yemotCall({ callId: ymDigitMenuCallId, speech: "1" }); // 1 = ניהול חשבונות
    assert(ymDigitBalance.includes("היתרה הנוכחית שלך היא"), "הקשת 1 בתפריט הראשי שקולה לאמירת 'ניהול חשבונות'");

    const ymDigitTxCallId = `${ymCallId}-digit-tx`;
    await yemotCall({ callId: ymDigitTxCallId, phone: "0500000001" });
    const ymDigitTxType = await yemotCall({ callId: ymDigitTxCallId, speech: "2" }); // 2 = תנועות
    assert(ymDigitTxType.includes("מעשרות") && ymDigitTxType.includes("1 להכנסה"), "הקשת 2 בתפריט הראשי שקולה לאמירת 'תנועות', ומזכירה גם קיצורי הקשה לשלב הבא (כולל מעשרות)");
    const ymDigitIncome = await yemotCall({ callId: ymDigitTxCallId, speech: "1" }); // 1 = הכנסה
    assert(ymDigitIncome.includes("מה סכום ההכנסה"), "הקשת 1 בבחירת סוג תנועה שקולה לאמירת 'הכנסה'");
    const ymDigitIncomeCategoryPrompt = await yemotCall({ callId: ymDigitTxCallId, speech: "500" });
    assert(ymDigitIncomeCategoryPrompt.includes("מאיזה מקור ההכנסה"), "אחרי הסכום בהקשות ממשיכים ישר לתפריט מקור ההכנסה בהקשה");
    await yemotCall({ callId: ymDigitTxCallId, speech: "1" }); // 1 = משכורת
    const ymDigitIncomeConfirm = await yemotCall({ callId: ymDigitTxCallId, speech: "#" });
    assert(
      ymDigitIncomeConfirm.includes("נשמר") && ymDigitIncomeConfirm.includes("רוצים עוד הכנסה"),
      "זרימה מלאה של תנועה דרך הקשות בלבד (בלי מילה אחת בדיבור) עובדת עד הסוף"
    );

    const ymDigitMentorCallId = `${ymCallId}-digit-mentor`;
    await yemotCall({ callId: ymDigitMentorCallId, phone: "0500000001" });
    await yemotCall({ callId: ymDigitMentorCallId, speech: "3" }); // 3 = חונכות
    const ymDigitMentorAction = await yemotCall({ callId: ymDigitMentorCallId, speech: "תלמיד בדיקה" });
    assert(ymDigitMentorAction.includes("1 לכניסה") && ymDigitMentorAction.includes("2 ליציאה"), "אחרי זיהוי תלמיד, מוזכרים גם קיצורי הקשה לכניסה/יציאה/מפגש רגיל");

    console.log("\n⭐ כוכבית (*) - חזרה לתפריט הראשי מכל מקום בשיחה (ימות)");
    // משוב אמיתי ממשתמש: לא הייתה דרך מהירה "לצאת" מתת-תפריט/שאלת אישור בלי להשלים אותה או להגיד "לא".
    const ymStarMidMenuCallId = `${ymCallId}-star-mid-menu`;
    await yemotCall({ callId: ymStarMidMenuCallId, phone: "0500000001" });
    await yemotCall({ callId: ymStarMidMenuCallId, speech: "תנועות" });
    const ymStarMidMenuBack = await yemotCall({ callId: ymStarMidMenuCallId, speech: "*" });
    assert(
      ymStarMidMenuBack.includes("תפריט הראשי") && ymStarMidMenuBack.includes("ניהול חשבונות"),
      "הקשת כוכבית באמצע תת-תפריט (בחירת סוג תנועה) חוזרת ישר לתפריט הראשי"
    );

    const ymStarMidConfirmCallId = `${ymCallId}-star-mid-confirm`;
    await yemotCall({ callId: ymStarMidConfirmCallId, phone: "0500000001" });
    await yemotCall({ callId: ymStarMidConfirmCallId, speech: "הכנסה" });
    await yemotCall({ callId: ymStarMidConfirmCallId, speech: "999" });
    const ymStarConfirmPrompt = await yemotCall({ callId: ymStarMidConfirmCallId, speech: "1" }); // 1 = משכורת
    assert(
      ymStarConfirmPrompt.includes("הקישו 1") && ymStarConfirmPrompt.includes("הקישו 2") && ymStarConfirmPrompt.includes("הקישו 3"),
      "שאלת האישור בימות מזכירה את שלושת האפשרויות: 1 לאישור, 2 לשינוי, 3 לביטול - בלי 'אמרו כן'"
    );
    assert(!ymStarConfirmPrompt.includes("אמרו כן"), "שאלת האישור בימות כבר לא מבקשת לומר 'כן' בקול - רק הקשה");
    const ymStarMidConfirmBack = await yemotCall({ callId: ymStarMidConfirmCallId, speech: "*" });
    assert(
      ymStarMidConfirmBack.includes("תפריט הראשי") && !ymStarMidConfirmBack.includes("נשמר"),
      "הקשת כוכבית גם באמצע שאלת אישור חוזרת לתפריט הראשי, בלי לשמור את התנועה"
    );
    const afterStarConfirm = await api("GET", "/api/transactions", null, token);
    assert(
      !afterStarConfirm.data.transactions.some(t => t.source === "phone" && t.amount === 999),
      "התנועה שבוטלה בכוכבית מתוך שאלת האישור אכן לא נשמרה במסד הנתונים"
    );

    console.log("\n🍔 תפריט קטגוריות הוצאה קבוע בהקשה בלבד (ימות): 1=מזון...6=ביגוד, 7=אחר");
    // משוב אמיתי ממשתמש: "לסדר בקטגוריות מזון/תחבורה... שיהיה רק עם הקשות, לא זיהוי דיבור".
    const ymCategoryMenuCallId = `${ymCallId}-category-menu`;
    await yemotCall({ callId: ymCategoryMenuCallId, phone: "0500000001" });
    await yemotCall({ callId: ymCategoryMenuCallId, speech: "הוצאה" });
    const ymCategoryMenuPrompt = await yemotCall({ callId: ymCategoryMenuCallId, speech: "48" });
    assert(
      /,1,1,7,No,/.test(ymCategoryMenuPrompt) && ymCategoryMenuPrompt.includes("1 מזון") && ymCategoryMenuPrompt.includes("7 אחר"),
      "אחרי הסכום, שאלת הקטגוריה נשלחת בפרוטוקול ימות במצב הקשה טהור (לא זיהוי דיבור), עם רשימת הקטגוריות הממוספרת"
    );
    const ymCategoryMenuDigit3 = await yemotCall({ callId: ymCategoryMenuCallId, speech: "3" }); // 3 = דיור
    assert(ymCategoryMenuDigit3.includes("דיור"), "הקשת 3 בתפריט הקטגוריות שקולה לבחירת 'דיור', בלי לומר את המילה בקול");
    await yemotCall({ callId: ymCategoryMenuCallId, speech: "1" }); // מאשר (1=אישור בשאלת האישור המשולשת)
    const afterCategoryDigit3Saved = await api("GET", "/api/transactions", null, token);
    assert(
      afterCategoryDigit3Saved.data.transactions.some(t => t.source === "phone" && t.amount === 48 && t.category === "דיור"),
      "התנועה נשמרה עם הקטגוריה שנבחרה בהקשה (דיור), לא עם קטגוריית ברירת מחדל כלשהי"
    );

    const ymCategoryOtherCallId = `${ymCallId}-category-other`;
    await yemotCall({ callId: ymCategoryOtherCallId, phone: "0500000001" });
    await yemotCall({ callId: ymCategoryOtherCallId, speech: "הוצאה" });
    await yemotCall({ callId: ymCategoryOtherCallId, speech: "22" });
    const ymCategoryOtherOffer = await yemotCall({ callId: ymCategoryOtherCallId, speech: "7" }); // 7 = אחר
    assert(ymCategoryOtherOffer.includes("לתאר במילים חופשיות"), "הקשת 7 (אחר) בתפריט הקטגוריות עדיין מציעה לתאר את הקטגוריה בקול חופשי");
    const ymCategoryOtherConfirm = await yemotCall({ callId: ymCategoryOtherCallId, speech: "תרופות" });
    assert(ymCategoryOtherConfirm.includes("תרופות"), "קטגוריה מותאמת-אישית שהוכתבה אחרי 'אחר' עדיין נקלטת כטקסט חופשי כרגיל");

    console.log("\n1️⃣2️⃣3️⃣ שאלת אישור משולשת בהקשה בלבד (ימות): 1=אישור, 2=שינוי, 3=ביטול - בלי זיהוי דיבור");
    // משוב אמיתי ממשתמש: לא צריך לדבר בכלל בשאלת אישור - מספיק להקיש. גם בודקים שהתגובה עצמה
    // (לא רק הטקסט) היא במצב הקשה טהור (tap, כמו קוד PIN) - לא read=...voice... הרגיל.
    const ymMenuConfirmCallId = `${ymCallId}-menu-confirm`;
    await yemotCall({ callId: ymMenuConfirmCallId, phone: "0500000001" });
    await yemotCall({ callId: ymMenuConfirmCallId, speech: "הוצאה" });
    await yemotCall({ callId: ymMenuConfirmCallId, speech: "40" }); // סכום -> שואל קטגוריה
    const ymMenuConfirmPrompt = await yemotCall({ callId: ymMenuConfirmCallId, speech: "1" }); // 1=מזון -> מגיע לשאלת האישור
    assert(
      /,1,1,7,No,/.test(ymMenuConfirmPrompt),
      "שאלת האישור נשלחת בפרוטוקול ימות במצב הקשה טהור (1 ספרה בדיוק, sec_wait=7, בלי הקראה חוזרת), לא במצב זיהוי דיבור"
    );
    // 2 = "שינוי" - חוזרים להתחלת הפריט (סכום), לא מבטלים ולא חוזרים לתפריט הראשי
    const ymMenuChange = await yemotCall({ callId: ymMenuConfirmCallId, speech: "2" });
    assert(
      ymMenuChange.includes("כמה עלה") && !ymMenuChange.includes("תפריט הראשי") && !ymMenuChange.includes("נשמר"),
      "הקשת 2 (שינוי) בשאלת האישור חוזרת ישר לשאלת הסכום מחדש, לא לתפריט הראשי ולא מבטלת סתם"
    );
    await yemotCall({ callId: ymMenuConfirmCallId, speech: "55" });
    await yemotCall({ callId: ymMenuConfirmCallId, speech: "1" }); // 1 = מזון
    const ymMenuChangeConfirm = await yemotCall({ callId: ymMenuConfirmCallId, speech: "1" });
    assert(
      ymMenuChangeConfirm.includes("נשמר") && ymMenuChangeConfirm.includes("55"),
      "אחרי 'שינוי' אפשר להזין את הפריט מחדש (סכום שונה) ולשמור אותו בהצלחה כרגיל"
    );
    const afterMenuChange = await api("GET", "/api/transactions", null, token);
    assert(
      afterMenuChange.data.transactions.some(t => t.source === "phone" && t.amount === 55 && t.category === "מזון") &&
      !afterMenuChange.data.transactions.some(t => t.amount === 40),
      "רק התנועה שאושרה אחרי ה'שינוי' (55) נשמרה - לא הסכום המקורי שוותר עליו (40)"
    );
    // 3 = "ביטול" - חוזרים לתפריט הראשי, בלי לשמור כלום
    const ymMenuCancelCallId = `${ymCallId}-menu-cancel`;
    await yemotCall({ callId: ymMenuCancelCallId, phone: "0500000001" });
    await yemotCall({ callId: ymMenuCancelCallId, speech: "הכנסה" });
    await yemotCall({ callId: ymMenuCancelCallId, speech: "70" });
    await yemotCall({ callId: ymMenuCancelCallId, speech: "1" }); // 1 = משכורת -> מגיע לשאלת האישור
    const ymMenuCancel = await yemotCall({ callId: ymMenuCancelCallId, speech: "3" });
    assert(ymMenuCancel.includes("בוטל") && ymMenuCancel.includes("ניהול חשבונות"), "הקשת 3 (ביטול) בשאלת האישור חוזרת לתפריט הראשי");
    const afterMenuCancel = await api("GET", "/api/transactions", null, token);
    assert(!afterMenuCancel.data.transactions.some(t => t.amount === 70), "התנועה שבוטלה בהקשת 3 אכן לא נשמרה במסד הנתונים");

    console.log("\n🏷️ תנועות: תפריט קטגוריות הכנסה (הקשה) - 1=משכורת, 2=ביטוח לאומי, 3=אחר עם טקסט חופשי");
    // משוב אמיתי ממשתמש: "לגבי קטגוריות... הכנסה שיהיה עוד קטגוריות... ביטוח לאומי משכורת... בקטגוריה אחר שיהיה טקסט חופשי".
    const ymIncomeCategoryMenuCallId = `${ymCallId}-income-category-menu`;
    await yemotCall({ callId: ymIncomeCategoryMenuCallId, phone: "0500000001" });
    await yemotCall({ callId: ymIncomeCategoryMenuCallId, speech: "הכנסה" });
    const ymIncomeCategoryPrompt = await yemotCall({ callId: ymIncomeCategoryMenuCallId, speech: "120" });
    assert(
      ymIncomeCategoryPrompt.includes("1") && ymIncomeCategoryPrompt.includes("משכורת") && ymIncomeCategoryPrompt.includes("ביטוח לאומי"),
      "אחרי סכום ההכנסה, תפריט הקטגוריות בהקשה מציע גם 'משכורת' וגם 'ביטוח לאומי'"
    );
    const ymIncomeCategoryDigit2 = await yemotCall({ callId: ymIncomeCategoryMenuCallId, speech: "2" }); // 2 = ביטוח לאומי
    assert(ymIncomeCategoryDigit2.includes("ביטוח לאומי"), "הקשת 2 בתפריט קטגוריות ההכנסה שקולה לבחירת 'ביטוח לאומי'");
    await yemotCall({ callId: ymIncomeCategoryMenuCallId, speech: "1" }); // מאשר
    const afterIncomeCategoryDigit2 = await api("GET", "/api/transactions", null, token);
    assert(
      afterIncomeCategoryDigit2.data.transactions.some(t => t.source === "phone" && t.amount === 120 && t.category === "ביטוח לאומי" && t.type === "income"),
      "התנועה נשמרה עם קטגוריית ההכנסה שנבחרה בהקשה (ביטוח לאומי)"
    );

    const ymIncomeCategoryOtherCallId = `${ymCallId}-income-category-other`;
    await yemotCall({ callId: ymIncomeCategoryOtherCallId, phone: "0500000001" });
    await yemotCall({ callId: ymIncomeCategoryOtherCallId, speech: "הכנסה" });
    await yemotCall({ callId: ymIncomeCategoryOtherCallId, speech: "250" });
    const ymIncomeCategoryOtherOffer = await yemotCall({ callId: ymIncomeCategoryOtherCallId, speech: "3" }); // 3 = אחר
    assert(ymIncomeCategoryOtherOffer.includes("לתאר במילים חופשיות"), "הקשת 3 (אחר) בתפריט קטגוריות ההכנסה מציעה לתאר את המקור בקול חופשי");
    const ymIncomeCategoryOtherConfirm = await yemotCall({ callId: ymIncomeCategoryOtherCallId, speech: "מענק לימודים" });
    assert(ymIncomeCategoryOtherConfirm.includes("מענק לימודים"), "מקור הכנסה מותאם-אישית שהוכתב אחרי 'אחר' נקלט כטקסט חופשי, בדיוק כמו בקטגוריות ההוצאה");
    await yemotCall({ callId: ymIncomeCategoryOtherCallId, speech: "1" }); // מאשר
    const afterIncomeCategoryOther = await api("GET", "/api/transactions", null, token);
    assert(
      afterIncomeCategoryOther.data.transactions.some(t => t.source === "phone" && t.amount === 250 && t.category === "מענק לימודים"),
      "התנועה נשמרה עם מקור ההכנסה המותאם-אישית שהוכתב ('מענק לימודים'), לא עם 'אחר'"
    );

    console.log("\n🙏 מעשרות: קטגוריה נפרדת (חוץ מהכנסה/הוצאה) - אומרים/מקישים 'מעשרות' ומדווח כמה ניתן");
    // משוב אמיתי ממשתמש: "חוץ מהכנסה והוצאה, קטגוריה של מעשרות - שאפשר לומר או להקיש מעשרות, ואומר
    // כמה מעשרות הוא נתן". קיצור ישיר מהתפריט הראשי (כמו הכנסה/הוצאה), בלי לעבור דרך תפריט בחירת
    // קטגוריה (היא כבר ידועה מראש) - ובסוף מדווח את סך המעשר שניתן עד כה, לא רק "רוצים עוד משהו" כללי.
    const ymTitheCallId = `${ymCallId}-tithe`;
    await yemotCall({ callId: ymTitheCallId, phone: "0500000001" });
    const ymTitheAmountPrompt = await yemotCall({ callId: ymTitheCallId, speech: "מעשרות" });
    assert(ymTitheAmountPrompt.includes("כמה מעשר נתת"), "אמירת 'מעשרות' מהתפריט הראשי עוברת ישר לשאלת הסכום, בלי לעבור דרך תפריט בחירת קטגוריה");
    const ymTitheConfirmPrompt = await yemotCall({ callId: ymTitheCallId, speech: "180" });
    assert(
      ymTitheConfirmPrompt.includes("180") && ymTitheConfirmPrompt.includes("מעשר") && ymTitheConfirmPrompt.includes("הקישו 1"),
      "הסכום נקרא בחזרה לאישור, עם קיצור הקשה מהיר (בימות - מצב הקשה טהור)"
    );
    const ymTitheDone = await yemotCall({ callId: ymTitheCallId, speech: "1" }); // מאשר
    assert(
      ymTitheDone.includes("נשמר") && ymTitheDone.includes("נתת 180") && ymTitheDone.includes("סך הכל נתת עד כה"),
      "אחרי אישור, המערכת מדווחת כמה מעשר ניתן בפעולה הזו, וגם את הסך הכל שניתן עד כה - לא תפריט 'עוד משהו' כללי"
    );
    const afterTithe = await api("GET", "/api/transactions", null, token);
    const titheTx = afterTithe.data.transactions.find(t => t.source === "phone" && t.amount === 180 && t.category === "מעשרות");
    assert(titheTx && titheTx.type === "expense", "התנועה נשמרה כהוצאה עם קטגוריית 'מעשרות' בדיוק, בלי לעבור דרך תפריט בחירת קטגוריה בכלל");

    console.log("\n🙏 מעשרות: גם דרך תת-תפריט 'תנועות' (הקשה 3, אחרי הכנסה/הוצאה), וגם דרך Twilio");
    const ymTitheViaTxCallId = `${ymCallId}-tithe-via-tx`;
    await yemotCall({ callId: ymTitheViaTxCallId, phone: "0500000001" });
    await yemotCall({ callId: ymTitheViaTxCallId, speech: "תנועות" });
    const ymTitheViaTxAmountPrompt = await yemotCall({ callId: ymTitheViaTxCallId, speech: "3" }); // 3 = מעשרות
    assert(ymTitheViaTxAmountPrompt.includes("כמה מעשר נתת"), "הקשת 3 בתת-תפריט 'תנועות' (אחרי הכנסה/הוצאה) שקולה לאמירת 'מעשרות'");
    await yemotCall({ callId: ymTitheViaTxCallId, speech: "50" });
    const ymTitheViaTxDone = await yemotCall({ callId: ymTitheViaTxCallId, speech: "1" });
    assert(ymTitheViaTxDone.includes("נשמר") && ymTitheViaTxDone.includes("נתת 50"), "תנועת מעשרות שנוספה דרך תת-תפריט 'תנועות' נשמרת ומדווחת כרגיל");

    const titheCallSid = `${callSid}-tithe`;
    await ivrCall(titheCallSid, "+972500000001");
    const titheAmountPrompt = await ivrSay(titheCallSid, "מעשרות");
    assert(titheAmountPrompt.includes("כמה מעשר נתת"), "אמירת 'מעשרות' דרך Twilio (בלי הקשות) גם היא עוברת ישר לשאלת הסכום");
    const titheConfirmPrompt = await ivrSay(titheCallSid, "70");
    assert(titheConfirmPrompt.includes("70") && titheConfirmPrompt.includes("לאשר"), "הסכום נקרא בחזרה לאישור גם ב-Twilio (זיהוי דיבור - 'אמרו כן')");
    const titheDone = await ivrSay(titheCallSid, "כן");
    assert(titheDone.includes("נשמר") && titheDone.includes("נתת 70"), "אישור בקול (Twilio) שומר את תנועת המעשר ומדווח את הסכום שניתן");

    console.log("\n🔀 תפריט המשך ממוקד אחרי שמירת תנועה: 1=עוד מאותו סוג, 2=לעבור לסוג השני, 3=לסיים");
    // משוב אמיתי ממשתמש: "אחרי שכבר כתבתי וסימנתי הכנסה... להוספה הכנסות הקישו 1 לעבור להוצאה הקישו 2 לסיים הקישו 3".
    const ymContinueSameCallId = `${ymCallId}-continue-same`;
    await yemotCall({ callId: ymContinueSameCallId, phone: "0500000001" });
    await yemotCall({ callId: ymContinueSameCallId, speech: "הכנסה" });
    await yemotCall({ callId: ymContinueSameCallId, speech: "10" });
    await yemotCall({ callId: ymContinueSameCallId, speech: "1" }); // משכורת
    const ymContinueSameDone = await yemotCall({ callId: ymContinueSameCallId, speech: "1" }); // מאשר -> תפריט המשך
    assert(
      ymContinueSameDone.includes("רוצים עוד הכנסה") && ymContinueSameDone.includes("לעבור להוצאה") && ymContinueSameDone.includes("לסיים? הקישו 3"),
      "אחרי שמירת הכנסה, תפריט ההמשך הממוקד מזכיר בדיוק את שלושת האפשרויות: עוד הכנסה, לעבור להוצאה, לסיים"
    );
    const ymContinueSameNextAmount = await yemotCall({ callId: ymContinueSameCallId, speech: "1" }); // 1 = עוד הכנסה
    assert(ymContinueSameNextAmount.includes("מה סכום ההכנסה"), "הקשת 1 בתפריט ההמשך עוברת ישר לשאלת סכום הכנסה נוספת, בלי לחזור לתפריט הראשי");
    await yemotCall({ callId: ymContinueSameCallId, speech: "20" });
    await yemotCall({ callId: ymContinueSameCallId, speech: "1" }); // משכורת
    await yemotCall({ callId: ymContinueSameCallId, speech: "1" }); // מאשר
    const afterContinueSame = await api("GET", "/api/transactions", null, token);
    assert(
      afterContinueSame.data.transactions.some(t => t.source === "phone" && t.amount === 10 && t.type === "income") &&
      afterContinueSame.data.transactions.some(t => t.source === "phone" && t.amount === 20 && t.type === "income"),
      "שתי ההכנסות שנוספו ברצף דרך תפריט ההמשך (10 ואז 20) אכן נשמרו שתיהן"
    );

    const ymContinueSwitchCallId = `${ymCallId}-continue-switch`;
    await yemotCall({ callId: ymContinueSwitchCallId, phone: "0500000001" });
    await yemotCall({ callId: ymContinueSwitchCallId, speech: "הכנסה" });
    await yemotCall({ callId: ymContinueSwitchCallId, speech: "15" });
    await yemotCall({ callId: ymContinueSwitchCallId, speech: "1" }); // משכורת
    await yemotCall({ callId: ymContinueSwitchCallId, speech: "1" }); // מאשר -> תפריט המשך
    const ymContinueSwitchAmount = await yemotCall({ callId: ymContinueSwitchCallId, speech: "2" }); // 2 = לעבור להוצאה
    assert(ymContinueSwitchAmount.includes("כמה עלה") || ymContinueSwitchAmount.includes("סכום ההוצאה"), "הקשת 2 בתפריט ההמשך עוברת ישר לשאלת סכום הוצאה, בלי לחזור לתפריט הראשי");
    await yemotCall({ callId: ymContinueSwitchCallId, speech: "18" });
    const ymContinueSwitchCategoryPrompt = await yemotCall({ callId: ymContinueSwitchCallId, speech: "1" }); // 1 = מזון
    assert(ymContinueSwitchCategoryPrompt.includes("מזון") && ymContinueSwitchCategoryPrompt.includes("הקישו 1"), "אחרי בחירת קטגוריית ההוצאה מגיעים ישר לשאלת האישור");
    const ymContinueSwitchDone = await yemotCall({ callId: ymContinueSwitchCallId, speech: "1" }); // מאשר
    assert(
      ymContinueSwitchDone.includes("נשמר") && ymContinueSwitchDone.includes("רוצים עוד הוצאה"),
      "אחרי המעבר מהכנסה להוצאה דרך תפריט ההמשך, ההוצאה נשמרת ותפריט ההמשך הבא מתייחס ל'הוצאה' (הסוג האחרון שנשמר)"
    );
    const afterContinueSwitch = await api("GET", "/api/transactions", null, token);
    assert(
      afterContinueSwitch.data.transactions.some(t => t.source === "phone" && t.amount === 15 && t.type === "income") &&
      afterContinueSwitch.data.transactions.some(t => t.source === "phone" && t.amount === 18 && t.type === "expense" && t.category === "מזון"),
      "גם ההכנסה (15) וגם ההוצאה (18) שנוספו ברצף דרך תפריט ההמשך נשמרו נכון, כל אחת עם הסוג הנכון שלה"
    );

    console.log("\n📋 חונכות: תפריט-הקשה של התלמידים הרשומים ('על איזה תלמיד רוצים לדווח?')");
    // משוב אמיתי ממשתמש: "אחרי שרשמתי כמה תלמידים... שיהיה לפי הרשימה, אם הראשון הוא X לחצו 1".
    // "תלמיד בדיקה" (sid) כבר קיים בשלב הזה (נוצר דרך ה-API למעלה) - קובעים את המיקום שלו ברשימה
    // בפועל (לפי מיון א-ב), כדי לא להניח מיקום קבוע.
    const studentsBeforeList = await api("GET", "/api/students", null, token);
    const sortedNames = studentsBeforeList.data.students.map(s => s.name).sort((a, b) => a.localeCompare(b, "he"));
    const testStudentIndex = sortedNames.indexOf("תלמיד בדיקה");
    assert(testStudentIndex >= 0, "'תלמיד בדיקה' קיים ברשימת התלמידים של החונך לפני תחילת בדיקות התפריט הממוספר");

    const ymStudentListCallId = `${ymCallId}-student-list`;
    await yemotCall({ callId: ymStudentListCallId, phone: "0500000001" });
    const ymStudentListPrompt = await yemotCall({ callId: ymStudentListCallId, speech: "חונכות" });
    assert(
      ymStudentListPrompt.includes("תלמיד בדיקה") && ymStudentListPrompt.includes("הקישו 0") && !ymStudentListPrompt.includes("מה שם התלמיד"),
      "כניסה ל'חונכות' עם תלמידים רשומים מציגה תפריט ממוספר (לא שאלת 'מה שם התלמיד' ישירות), עם שסתום הקשת 0"
    );
    const ymStudentListPick = await yemotCall({ callId: ymStudentListCallId, speech: String(testStudentIndex + 1) });
    assert(ymStudentListPick.includes("תלמיד בדיקה") && ymStudentListPick.includes("1 לכניסה"), "בחירת המספר המתאים ל'תלמיד בדיקה' ברשימה עוברת ישר לבחירת סוג הפעולה עבורו, בלי לומר את השם בקול");

    // הקשת 0 - שסתום-בטיחות לתלמיד שלא ברשימה (או פשוט מעדיפים לומר את השם) - חוזר לשלב ההכתבה הרגיל
    const ymStudentListEscapeCallId = `${ymCallId}-student-list-escape`;
    await yemotCall({ callId: ymStudentListEscapeCallId, phone: "0500000001" });
    await yemotCall({ callId: ymStudentListEscapeCallId, speech: "חונכות" });
    const ymStudentListEscape = await yemotCall({ callId: ymStudentListEscapeCallId, speech: "0" });
    assert(ymStudentListEscape.includes("מה שם התלמיד"), "הקשת 0 בתפריט הממוספר חוזרת לשלב ההכתבה החופשית הרגילה (לתלמיד שלא ברשימה)");

    // גיבוי: גם אמירת השם ישירות (בלי להקיש מספר) בשלב התפריט הממוספר עדיין מוצאת את התלמיד -
    // חשוב בעיקר לערוץ Twilio (אין שם הקשות אמינות), אבל עובד גם בימות כרשת ביטחון נוספת.
    const ymStudentListSpokenCallId = `${ymCallId}-student-list-spoken`;
    await yemotCall({ callId: ymStudentListSpokenCallId, phone: "0500000001" });
    await yemotCall({ callId: ymStudentListSpokenCallId, speech: "חונכות" });
    const ymStudentListSpoken = await yemotCall({ callId: ymStudentListSpokenCallId, speech: "תלמיד בדיקה" });
    assert(ymStudentListSpoken.includes("1 לכניסה"), "אמירת שם התלמיד בקול (בלי להקיש מספר) בשלב התפריט הממוספר עדיין מוצאת אותו כגיבוי");

    console.log("\n➕ חונכות: הוספת תלמיד חדש ישירות מהטלפון (בלי לגשת לאתר), אם השם לא נמצא ברשימת החונך");
    const ymAddStudentCallId = `${ymCallId}-add-student`;
    await yemotCall({ callId: ymAddStudentCallId, phone: "0500000001" });
    await yemotCall({ callId: ymAddStudentCallId, speech: "חונכות" });
    await yemotCall({ callId: ymAddStudentCallId, speech: "0" }); // 0 = תלמיד שלא ברשימה (יש כבר תלמידים רשומים מבדיקות קודמות)
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

    // תוקן (אבחון בפועל מול קו אמיתי): מילת המפתח "להוסיף" (צורת מקור/עתיד, הניסוח הכי טבעי בעברית
    // לענות על "רוצים להוסיף אותו כתלמיד חדש?") הייתה חסרה מרשימת מילות המפתח - היו רק "הוסף"/"הוסיפו"
    // (ציווי) - ולכן נפלה בטעות למסלול "מנסים שוב כאילו זה שם תלמיד" במקום להוסיף בפועל.
    const ymAddStudentSpokenCallId = `${ymCallId}-add-student-spoken`;
    await yemotCall({ callId: ymAddStudentSpokenCallId, phone: "0500000001" });
    await yemotCall({ callId: ymAddStudentSpokenCallId, speech: "חונכות" });
    await yemotCall({ callId: ymAddStudentSpokenCallId, speech: "0" }); // 0 = תלמיד שלא ברשימה
    await yemotCall({ callId: ymAddStudentSpokenCallId, speech: "יוסי כהן" });
    const ymAddStudentSpokenDone = await yemotCall({ callId: ymAddStudentSpokenCallId, speech: "להוסיף" });
    assert(
      ymAddStudentSpokenDone.includes("נוסף תלמיד חדש") && ymAddStudentSpokenDone.includes("יוסי כהן"),
      "אמירת 'להוסיף' (לא רק 'הוסף'/הקשת 1) בשלב אישור הוספת תלמיד חדש אכן מוסיפה אותו בפועל, ולא מתפרשת בטעות כניסיון נוסף לומר שם"
    );

    // תוקן (באג אמיתי חמור שהתגלה בבדיקה חיה בפועל מול קו אמיתי - יצר בפועל תלמיד עם השם המילולי
    // "Digits-11" במסד הנתונים!): ימות לפעמים מדווחת על הקשה כפולה/ממושכת של אותה ספרה כמחרוזת חוזרת
    // ("Digits-11" עבור הקשת 1 פעמיים, לא "Digits-1" רגיל) - onlyDigits("Digits-11") מחזיר "11", לא
    // תואם בהשוואה מדויקת ל-"1", ונפל בעבר בטעות למסלול "מנסים שוב כאילו זה שם תלמיד" (ר' singleDigitPress/
    // looksLikeRawDigitsArtifact ב-routes/ivr.js).
    console.log("\n🐛 תוקן: שאריות הקשה גולמיות של ימות לא נופלות בטעות ליצירת תלמיד עם שם גיבריש");
    // מקרה 1: הקשה כפולה של **אותה** ספרה ("Digits-11", כלומר הוקשה 1 פעמיים) - נחשבת סלחנית כמו
    // הקשה בודדת (1=אישור), ומוסיפה את התלמיד **בשם הנכון** שכבר נאמר קודם - לא בשם "Digits-11".
    const ymDoubleDigitCallId = `${ymCallId}-double-digit`;
    await yemotCall({ callId: ymDoubleDigitCallId, phone: "0500000001" });
    await yemotCall({ callId: ymDoubleDigitCallId, speech: "חונכות" });
    await yemotCall({ callId: ymDoubleDigitCallId, speech: "0" }); // 0 = תלמיד שלא ברשימה
    await yemotCall({ callId: ymDoubleDigitCallId, speech: "דני אבידר" }); // שם שלא קיים -> מוצעת הוספה
    const ymDoubleDigitConfirm = await yemotCall({ callId: ymDoubleDigitCallId, speech: "Digits-11" });
    assert(
      ymDoubleDigitConfirm.includes("נוסף תלמיד חדש") && ymDoubleDigitConfirm.includes("דני אבידר"),
      "הקשה כפולה של אותה ספרה ('Digits-11') נחשבת כמו הקשה בודדת (1=אישור) - מוסיפה את התלמיד בשם הנכון שכבר נאמר, לא נופלת ל'ניסיון לומר שם' חדש"
    );

    // מקרה 2: הקשה מעורבת/לא-חד-משמעית ("Digits-12", שתי ספרות שונות) - לא ברור מה בדיוק התכוונו,
    // אז חוזרים על השאלה - **לא** יוצרים תלמיד עם השם המילולי "Digits-12" (זה בדיוק הבאג המקורי).
    const ymAmbiguousDigitCallId = `${ymCallId}-ambiguous-digit`;
    await yemotCall({ callId: ymAmbiguousDigitCallId, phone: "0500000001" });
    await yemotCall({ callId: ymAmbiguousDigitCallId, speech: "חונכות" });
    await yemotCall({ callId: ymAmbiguousDigitCallId, speech: "0" }); // 0 = תלמיד שלא ברשימה
    await yemotCall({ callId: ymAmbiguousDigitCallId, speech: "רונית שדה" }); // שם שלא קיים -> מוצעת הוספה
    const ymAmbiguousDigitResp = await yemotCall({ callId: ymAmbiguousDigitCallId, speech: "Digits-12" });
    assert(
      !ymAmbiguousDigitResp.includes("Digits") && ymAmbiguousDigitResp.includes("להוסיף את רונית שדה כתלמיד חדש"),
      "הקשה מעורבת לא-חד-משמעית ('Digits-12') לא נחשבת אישור מפורש - חוזרת על שאלת ההוספה, לא נופלת ל'ניסיון לומר שם'"
    );
    const studentsAfterAmbiguous = await api("GET", "/api/students", null, token);
    assert(
      !studentsAfterAmbiguous.data.students.some(s => s.name.includes("Digits")),
      "לא נוצר תלמיד עם שם שמכיל 'Digits' - הבאג המקורי (יצירת תלמיד עם שם כזה בפועל) לא חוזר"
    );
    const studentsAfterSpokenAdd = await api("GET", "/api/students", null, token);
    assert(
      studentsAfterSpokenAdd.data.students.some(s => s.name === "יוסי כהן"),
      "התלמיד שנוסף באמירת 'להוסיף' אכן נשמר במסד הנתונים"
    );

    console.log("\n➖ חונכות: הסרת תלמיד (מחיקה רכה, active=0) - גם מהטלפון וגם מהאתר");
    const ymRemoveCallId = `${ymCallId}-remove-student`;
    await yemotCall({ callId: ymRemoveCallId, phone: "0500000001" });
    await yemotCall({ callId: ymRemoveCallId, speech: "חונכות" });
    await yemotCall({ callId: ymRemoveCallId, speech: "משה ישראלי" });
    const ymRemoveConfirmPrompt = await yemotCall({ callId: ymRemoveCallId, speech: "4" }); // 4 = הסרת התלמיד
    assert(ymRemoveConfirmPrompt.includes("לאשר") && ymRemoveConfirmPrompt.includes("להסיר את משה ישראלי"), "הקשת 4 בשלב הפעולה מציעה לאשר הסרת התלמיד, ולא מסירה מיד בלי אישור");
    const ymRemoveDone = await yemotCall({ callId: ymRemoveCallId, speech: "כן" });
    assert(
      ymRemoveDone.includes("הוסר") && ymRemoveDone.includes("רוצים לעשות עוד משהו"),
      "אישור ההסרה חוזר לתפריט עם שאלה אם יש עוד משהו, ולא מנתק מיד"
    );
    const studentsAfterRemove = await api("GET", "/api/students", null, token);
    assert(!studentsAfterRemove.data.students.some(s => s.name === "משה ישראלי"), "אחרי ההסרה, התלמיד כבר לא מופיע ברשימת התלמידים הפעילים (/api/students)");

    const removeViaWeb = await api("DELETE", `/api/students/${addedStudent.id}`, null, token);
    assert(removeViaWeb.status === 404 || removeViaWeb.status === 200, "אותו נתיב הסרה (DELETE /api/students/:id) זמין גם לאתר - אידמפוטנטי, לא קורס גם אם כבר הוסר");

    const foreignStudent = await api("POST", "/api/students", { name: "תלמיד של מישהו אחר" }, parentToken);
    const foreignRemoveAttempt = await api("DELETE", `/api/students/${foreignStudent.data.student.id}`, null, token);
    assert(foreignRemoveAttempt.status === 404, "משתמש לא יכול להסיר תלמיד שאינו הבעלים שלו (404, לא חושף מידע)");

    console.log("\n🗣️ חונכות: דיווח מעקב חופשי על מפגש - עכשיו אפשר להכתיב אותו גם בטלפון (לא רק באתר)");
    // מפגש רגיל (quick-session) לא דורש checkin קודם - הכי קצר לבדיקה. משתמשים ב"תלמיד בדיקה" (sid),
    // שכבר עבר checkout+quick-session אחד דרך ה-API למעלה, כדי לוודא שההכתבה בטלפון מוסיפה מפגש
    // *נוסף* משלה (לא מתערבבת עם המפגשים הקודמים).
    const ymNoteCallId = `${ymCallId}-mentor-note`;
    await yemotCall({ callId: ymNoteCallId, phone: "0500000001" });
    await yemotCall({ callId: ymNoteCallId, speech: "חונכות" });
    await yemotCall({ callId: ymNoteCallId, speech: "תלמיד בדיקה" });
    const ymLessonPrepOffer = await yemotCall({ callId: ymNoteCallId, speech: "3" }); // 3 = מפגש רגיל
    assert(
      ymLessonPrepOffer.includes("נרשם מפגש עבור תלמיד בדיקה") && ymLessonPrepOffer.includes("הכנה לשיעור") && ymLessonPrepOffer.includes("שיתוף פעולה"),
      "אחרי מפגש רגיל, מוצעת קודם גם אפשרות למלא טופס הכנה לשיעור בקצרה (כולל שיתוף פעולה)"
    );
    const ymNoteOffer = await yemotCall({ callId: ymNoteCallId, speech: "2" }); // 2 = לא, בלי טופס הכנה לשיעור הפעם
    assert(
      ymNoteOffer.includes("דיווח מעקב חופשי") && ymNoteOffer.includes("הקישו 1"),
      "אחרי דחיית טופס ההכנה לשיעור, מוצעת אפשרות להוסיף גם דיווח מעקב חופשי - עם קיצור הקשה 1/2 אמין (לא רק מילה)"
    );
    const ymNoteSpeakPrompt = await yemotCall({ callId: ymNoteCallId, speech: "1" }); // 1 = כן, רוצים להכתיב
    assert(ymNoteSpeakPrompt.includes("לתאר במילים חופשיות"), "הקשת 1 (או אמירת 'כן') על ההצעה עוברת לשלב ההכתבה החופשית");
    const ymNoteConfirmPrompt = await yemotCall({ callId: ymNoteCallId, speech: "עבדנו על קריאה שוטפת, יש שיפור ניכר" });
    assert(
      ymNoteConfirmPrompt.includes("עבדנו על קריאה שוטפת, יש שיפור ניכר") && ymNoteConfirmPrompt.includes("לאשר"),
      "הדיווח שהוכתב מוקרא בחזרה לאישור, בדיוק כמו דיווח מטפל/הערת מפקח"
    );
    const ymNoteDone = await yemotCall({ callId: ymNoteCallId, speech: "כן" });
    assert(
      ymNoteDone.includes("הדיווח נשמר") && ymNoteDone.includes("רוצים לעשות עוד משהו"),
      "אישור הקראת הדיווח משלים את השמירה וחוזר לתפריט הרגיל"
    );
    const sessionsAfterPhoneNote = await api("GET", `/api/students/${sid}/file`, null, token);
    const phoneNoteSession = sessionsAfterPhoneNote.data.timeline.find(
      t => t.kind === "session" && t.data.note === "עבדנו על קריאה שוטפת, יש שיפור ניכר"
    );
    assert(!!phoneNoteSession, "המפגש עם הדיווח שהוכתב בטלפון אכן נשמר במסד הנתונים (sessions.note), בדיוק כמו דיווח שמוזן באתר");
    const noteDictionaryAfterPhone = await api("GET", "/api/reports/dictionary?kind=session_note", null, token);
    assert(
      noteDictionaryAfterPhone.data.phrases.includes("עבדנו על קריאה שוטפת, יש שיפור ניכר"),
      "דיווח שהוכתב בטלפון נכנס גם הוא ל'מילון' הניסוחים האישי של החונך, בדיוק כמו דיווח שמוזן באתר"
    );

    console.log("\n🗣️ חונכות: אפשר גם לדלג על דיווח המעקב (הוא לא חובה) - גם באמירה וגם בהקשה");
    const ymNoteSkipCallId = `${ymCallId}-mentor-note-skip`;
    await yemotCall({ callId: ymNoteSkipCallId, phone: "0500000001" });
    await yemotCall({ callId: ymNoteSkipCallId, speech: "חונכות" });
    await yemotCall({ callId: ymNoteSkipCallId, speech: "תלמיד בדיקה" });
    await yemotCall({ callId: ymNoteSkipCallId, speech: "3" }); // 3 = מפגש רגיל -> מוצע קודם טופס הכנה לשיעור
    await yemotCall({ callId: ymNoteSkipCallId, speech: "2" }); // 2 = לא, בלי טופס הכנה לשיעור
    const ymNoteSkipDone = await yemotCall({ callId: ymNoteSkipCallId, speech: "2" }); // 2 = לא, לא רוצים דיווח
    assert(
      ymNoteSkipDone.includes("נרשם מפגש עבור תלמיד בדיקה") && ymNoteSkipDone.includes("רוצים לעשות עוד משהו") && !ymNoteSkipDone.includes("הדיווח נשמר"),
      "הקשת 2 (לא) על הצעת הדיווח משלימה את המפגש בלי דיווח, בלי להיתקע בשאלה"
    );

    console.log("\n📋 חונכות: טופס \"הכנה לשיעור\" בקצרה בטלפון (4 שדות), אחרי מפגש רגיל");
    // זרימה מלאה: 4 שדות מוכתבים בקול, אישור (1), נשמר ל-lesson_reports + נכנס ל'מילון' האישי -
    // כולל connection_cooperation ("שיתוף פעולה", נוסף בעקבות בקשה מפורשת אחרי הצמצום הראשוני לטופס).
    const ymLessonCallId = `${ymCallId}-lesson-prep`;
    await yemotCall({ callId: ymLessonCallId, phone: "0500000001" });
    await yemotCall({ callId: ymLessonCallId, speech: "חונכות" });
    await yemotCall({ callId: ymLessonCallId, speech: "תלמיד בדיקה" });
    await yemotCall({ callId: ymLessonCallId, speech: "3" }); // 3 = מפגש רגיל -> מוצע טופס הכנה לשיעור
    const ymLessonField1 = await yemotCall({ callId: ymLessonCallId, speech: "1" }); // 1 = כן, רוצים למלא
    assert(ymLessonField1.includes("הקטע שנלמד"), "אישור ההצעה עובר ישר לשאלת השדה הראשון (הקטע הנלמד)");
    const ymLessonField2 = await yemotCall({ callId: ymLessonCallId, speech: "חיבור וחיסור" });
    assert(ymLessonField2.includes("מטרת השיעור"), "אחרי השדה הראשון עוברים ישר לשדה השני (המטרה), בלי שאלת אישור באמצע");
    const ymLessonField3 = await yemotCall({ callId: ymLessonCallId, speech: "להבין חיבור עם נשיאה" });
    assert(ymLessonField3.includes("יושם בפועל"), "עוברים לשדה השלישי (יישום בפועל)");
    const ymLessonField4 = await yemotCall({ callId: ymLessonCallId, speech: "תרגלנו דוגמאות מהחיים" });
    assert(ymLessonField4.includes("שיתוף הפעולה"), "עוברים לשדה הרביעי (שיתוף פעולה)");
    const ymLessonConfirm = await yemotCall({ callId: ymLessonCallId, speech: "התלמיד השתתף באופן פעיל" });
    assert(
      ymLessonConfirm.includes("חיבור וחיסור") && ymLessonConfirm.includes("להבין חיבור עם נשיאה") &&
      ymLessonConfirm.includes("תרגלנו דוגמאות מהחיים") && ymLessonConfirm.includes("התלמיד השתתף באופן פעיל") &&
      ymLessonConfirm.includes("הקישו 1"),
      "אחרי 4 השדות, שאלת אישור אחת מרכזת את כל התוכן שנאסף (לא זיהוי דיבור - מצב הקשה טהור)"
    );
    const ymLessonSaved = await yemotCall({ callId: ymLessonCallId, speech: "1" }); // 1 = אישור
    assert(
      ymLessonSaved.includes("טופס ההכנה לשיעור נשמר") && ymLessonSaved.includes("דיווח מעקב חופשי"),
      "אישור שומר את הטופס, וממשיך אחר כך להצעת דיווח המעקב הרגילה (הזרימה הקיימת לא נשברה)"
    );
    await yemotCall({ callId: ymLessonCallId, speech: "2" }); // מדלגים על דיווח המעקב, לא רלוונטי כאן

    const lessonFileAfterPhone = await api("GET", `/api/students/${sid}/file`, null, token);
    const phoneLessonReport = lessonFileAfterPhone.data.timeline.find(
      t => t.kind === "lesson_report" && t.data.topic_studied === "חיבור וחיסור"
    );
    assert(
      !!phoneLessonReport && phoneLessonReport.data.goal === "להבין חיבור עם נשיאה" &&
      phoneLessonReport.data.practical_application === "תרגלנו דוגמאות מהחיים" &&
      phoneLessonReport.data.connection_cooperation === "התלמיד השתתף באופן פעיל",
      "כל 4 השדות שהוכתבו בטלפון נשמרו נכון ב-lesson_reports (כולל שיתוף פעולה)"
    );
    const topicDictAfterPhone = await api("GET", "/api/lesson-reports/dictionary?kind=lesson_topic_studied", null, token);
    const cooperationDictAfterPhone = await api("GET", "/api/lesson-reports/dictionary?kind=lesson_connection_cooperation", null, token);
    assert(
      topicDictAfterPhone.data.phrases.includes("חיבור וחיסור") && cooperationDictAfterPhone.data.phrases.includes("התלמיד השתתף באופן פעיל"),
      "השדות שהוכתבו בטלפון נכנסו ל'מילון' האישי (אותו kind בדיוק כמו באתר) - יוצעו גם באתר בפעם הבאה"
    );

    console.log("\n📋 חונכות: 'לא שמעתי' בשדה הכנה לשיעור מציע לבחור מתוך ה'מילון' בהקשה (לא להמשיך לנסות בקול)");
    const ymLessonRetryCallId = `${ymCallId}-lesson-prep-retry`;
    await yemotCall({ callId: ymLessonRetryCallId, phone: "0500000001" });
    await yemotCall({ callId: ymLessonRetryCallId, speech: "חונכות" });
    await yemotCall({ callId: ymLessonRetryCallId, speech: "תלמיד בדיקה" });
    await yemotCall({ callId: ymLessonRetryCallId, speech: "3" });
    await yemotCall({ callId: ymLessonRetryCallId, speech: "1" }); // רוצים למלא טופס
    const ymLessonEmptyRetry = await yemotCall({ callId: ymLessonRetryCallId, speech: "" }); // לא נשמע כלום
    assert(ymLessonEmptyRetry.includes("לא שמעתי") && ymLessonEmptyRetry.includes("להקיש 1"), "קלט ריק בשדה חופשי מציע גם לבחור מתוך ניסוחים קודמים בהקשה, לא רק לנסות שוב בקול");
    const ymLessonPickList = await yemotCall({ callId: ymLessonRetryCallId, speech: "1" }); // 1 = לבחור מתוך המילון
    assert(
      ymLessonPickList.includes("חיבור וחיסור") && ymLessonPickList.includes("1)"),
      "הקשת 1 מקריאה את הניסוחים הקודמים מה'מילון' האישי (כולל הניסוח שהוכתב בשיחה הקודמת), ממוספרים"
    );
    const ymLessonPickChosen = await yemotCall({ callId: ymLessonRetryCallId, speech: "1" }); // בוחרים ניסוח מספר 1
    assert(ymLessonPickChosen.includes("מטרת השיעור"), "בחירת ניסוח מהמילון (בהקשה, לא בקול) ממלאת את השדה ועוברת לשדה הבא");

    console.log("\n📋 חונכות: 'שינוי'/'ביטול' בשאלת האישור המרוכזת של טופס ההכנה לשיעור");
    // ממשיכים על אותה שיחה: ב'שינוי' (2) חוזרים להתחלת 4 השדות; אחרי מילוי מהיר, 'ביטול' (3) לא שומר כלום.
    await yemotCall({ callId: ymLessonRetryCallId, speech: "יעד לדוגמה" });
    await yemotCall({ callId: ymLessonRetryCallId, speech: "יישום לדוגמה" });
    const ymLessonBeforeChange = await yemotCall({ callId: ymLessonRetryCallId, speech: "שיתוף לדוגמה" });
    assert(ymLessonBeforeChange.includes("הקישו 2"), "שאלת האישור המרוכזת מזכירה גם אפשרות שינוי (2)");
    const ymLessonChange = await yemotCall({ callId: ymLessonRetryCallId, speech: "2" }); // 2 = שינוי
    assert(ymLessonChange.includes("הקטע שנלמד") && !ymLessonChange.includes("נשמר"), "הקשת 2 (שינוי) בשאלת האישור המרוכזת חוזרת ישר לשדה הראשון, לא שומרת כלום");
    await yemotCall({ callId: ymLessonRetryCallId, speech: "קטע חדש" });
    await yemotCall({ callId: ymLessonRetryCallId, speech: "מטרה חדשה" });
    await yemotCall({ callId: ymLessonRetryCallId, speech: "יישום חדש" });
    await yemotCall({ callId: ymLessonRetryCallId, speech: "שיתוף חדש" });
    const ymLessonCancel = await yemotCall({ callId: ymLessonRetryCallId, speech: "3" }); // 3 = ביטול
    assert(ymLessonCancel.includes("דיווח מעקב חופשי"), "הקשת 3 (ביטול) בשאלת האישור המרוכזת לא שומרת, וממשיכה ישר להצעת דיווח המעקב הרגילה");
    const lessonFileAfterCancel = await api("GET", `/api/students/${sid}/file`, null, token);
    assert(
      !lessonFileAfterCancel.data.timeline.some(t => t.kind === "lesson_report" && t.data.topic_studied === "קטע חדש"),
      "טופס שבוטל (הקשת 3) אכן לא נשמר במסד הנתונים"
    );

    console.log("\n🏷️ תנועות: קטגוריית הוצאה מותאמת-אישית - אמירת 'אחר' מציעה תיאור חופשי, ונשמר ל'מילון' לפעם הבאה");
    const customCatCallSid = `${callSid}-custom-category`;
    await ivrCall(customCatCallSid, "+972500000001");
    await ivrSay(customCatCallSid, "הוצאה");
    await ivrSay(customCatCallSid, "80");
    const customCatPrompt = await ivrSay(customCatCallSid, "אחר");
    assert(
      customCatPrompt.includes("לתאר במילים חופשיות"),
      "אמירת 'אחר' כמילה בודדת לא הופכת מיד לשם הקטגוריה - מוצעת אפשרות לתאר בקול חופשי מה זו הקטגוריה בעצם"
    );
    const customCatConfirm = await ivrSay(customCatCallSid, "תרופות");
    assert(customCatConfirm.includes("בקטגוריית תרופות"), "הקטגוריה שהוכתבה חופשי מוקראת בחזרה לאישור, לא נשארת 'אחר'");
    await ivrSay(customCatCallSid, "כן");
    const afterCustomCatTx = await api("GET", "/api/transactions", null, token);
    assert(
      afterCustomCatTx.data.transactions.some(t => t.source === "phone" && t.amount === 80 && t.category === "תרופות"),
      "התנועה נשמרה עם הקטגוריה המותאמת-אישית שהוכתבה ('תרופות'), לא עם 'אחר'"
    );
    const categoryDictionaryAfterPhone = await api("GET", "/api/transactions/dictionary", null, token);
    assert(
      categoryDictionaryAfterPhone.data.phrases.includes("תרופות"),
      "הקטגוריה המותאמת-אישית שהוכתבה בטלפון נכנסה ל'מילון' האישי, ותוצע גם באתר בפעם הבאה (datalist)"
    );

    console.log("\n🏷️ תנועות: 'מילון' קטגוריות נפרד להכנסות (לא רק להוצאות) - משוב אמיתי מהאתר");
    // תוקן (משוב אמיתי: "נכנסתי באתר כשאני לוחץ על הכנסה אין קטגוריה אם זה ביטוח לאומי או משכורת
    // או חונכות ואחר") - קודם /api/transactions/dictionary החזיר תמיד רק קטגוריות הוצאה, גם כשמוסיפים
    // הכנסה עם קטגוריה מותאמת-אישית (למשל "חונכות" כמקור הכנסה) - היא נשמרה ל-DB אבל לא הוצעה יותר.
    const incomeWithCategory = await api("POST", "/api/transactions", { type: "income", amount: 500, category: "חונכות" }, token);
    assert(incomeWithCategory.status === 201 && incomeWithCategory.data.transaction.category === "חונכות", "הוספת הכנסה עם קטגוריה מותאמת-אישית ('חונכות') דרך האתר הצליחה");
    const incomeDictionary = await api("GET", "/api/transactions/dictionary?type=income", null, token);
    assert(
      incomeDictionary.data.phrases.includes("חונכות"),
      "מילון ההכנסות (?type=income) כולל את הקטגוריה שהוזנה ('חונכות') - תוצע אוטומטית בפעם הבאה"
    );
    assert(
      !incomeDictionary.data.phrases.includes("תרופות"),
      "מילון ההכנסות לא מכיל קטגוריות הוצאה ('תרופות') - שני המילונים נפרדים לגמרי"
    );
    const expenseDictionaryStillDefault = await api("GET", "/api/transactions/dictionary", null, token);
    assert(
      !expenseDictionaryStillDefault.data.phrases.includes("חונכות"),
      "בלי פרמטר type בכלל (תאימות לאחור), עדיין מוחזר מילון ההוצאה בלבד - לא מתערבב עם קטגוריות הכנסה"
    );

    console.log("\n🏷️ תנועות: אם לא שומעים כלום בשלב הכתבת הקטגוריה החופשית, מבקשים שוב ולא נתקעים/קורסים");
    const emptyCustomCatCallSid = `${callSid}-custom-category-empty`;
    await ivrCall(emptyCustomCatCallSid, "+972500000001");
    await ivrSay(emptyCustomCatCallSid, "הוצאה");
    await ivrSay(emptyCustomCatCallSid, "40");
    await ivrSay(emptyCustomCatCallSid, "אחר");
    const emptyCustomCatRetry = await ivrSay(emptyCustomCatCallSid, "");
    assert(emptyCustomCatRetry.includes("לא שמעתי קטגוריה"), "קלט ריק בשלב הכתבת הקטגוריה החופשית מבקש שוב, לא קורס ולא נשמר קטגוריה ריקה");

    console.log("\n📝 הרשמה ישירות בטלפון (ימות המשיח) — אותה יכולת גם דרך ימות");
    const ymSignupCallId = `${ymCallId}-signup`;
    const ymSignupPhone = "0500000088";
    const ymSignupGreeting = await yemotCall({ callId: ymSignupCallId, phone: ymSignupPhone });
    assert(ymSignupGreeting.includes("אינו מזוהה") && ymSignupGreeting.includes("השם המלא"), "מספר לא מזוהה בימות מקבל הצעת הרשמה");
    const ymSignupPinPrompt = await yemotCall({ callId: ymSignupCallId, speech: "דנה לוי" });
    assert(
      ymSignupPinPrompt.includes("דנה לוי") && ymSignupPinPrompt.includes("קוד סודי") && ymSignupPinPrompt.includes(",no,4,4,7,"),
      "גם בימות, מיד אחרי הכתבת השם (בלי שאלת אישור נפרדת) מתבקש קוד PIN בן 4 ספרות בהקשה (מצב tap - max_digits/min_digits=4, sec_wait=7)"
    );
    const ymSignupPinConfirmPrompt = await yemotCall({ callId: ymSignupCallId, speech: "4321" });
    assert(
      ymSignupPinConfirmPrompt.includes("התקבל") && ymSignupPinConfirmPrompt.includes("שוב"),
      "אחרי הקשת 4 הספרות הראשונות, המענה פותח ב'התקבל' - כדי שהמתקשר ידע בבירור שההקשה נקלטה, גם עם עיכוב הרשת"
    );
    // תוקן (משוב אמיתי: "צריך לקצר... רק לומר מומלץ להוסיף מייל באתר ולהמשיך, בלי הקשות") - שלב
    // הכתבת המייל בטלפון הוסר לגמרי (גם בימות) - ההרשמה מסתיימת מיד אחרי הקשה כפולה תואמת של ה-PIN.
    const ymSignupDone = await yemotCall({ callId: ymSignupCallId, speech: "4321" });
    assert(
      ymSignupDone.includes("הוגדר בהצלחה") && ymSignupDone.includes("מומלץ להוסיף כתובת מייל") && ymSignupDone.includes("דנה לוי"),
      "גם בימות, אחרי הקשה כפולה תואמת של קוד ה-PIN, ההרשמה מסתיימת מיד עם משפט מידע קצר על מייל באתר (לא שאלה)"
    );

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
      "isConfigured() מחזיר false כל עוד YEMOT_API_TOKEN/YEMOT_EXTENSION_NUMBER/YEMOT_RECORD_EXTENSION/OPENAI_API_KEY לא מוגדרים יחד (מצב הבדיקות)"
    );
    const whisperMockResult = await speechToText.downloadAndTranscribe("some-call-id");
    assert(whisperMockResult === null, "downloadAndTranscribe() מחזיר null במצב MOCK, בלי לנסות פנייה רשתית כלשהי");

    // אימות טלפוני חינמי דרך ימות (ר' services/yemotAuth.js) - כמו Whisper, נשאר שקוף לחלוטין
    // (לא מנסה פנייה רשתית) כל עוד YEMOT_API_TOKEN/YEMOT_EXTENSION_NUMBER לא מוגדרים (מצב הבדיקות).
    const yemotAuth = require("../src/services/yemotAuth");
    assert(yemotAuth.isConfigured() === false, "yemotAuth.isConfigured() מחזיר false במצב הבדיקות (בלי YEMOT_API_TOKEN/YEMOT_EXTENSION_NUMBER)");
    const yemotAuthSendResult = await yemotAuth.sendCallerIdCode("+972500000001");
    assert(yemotAuthSendResult === false, "sendCallerIdCode() מחזיר false במצב לא-מוגדר, בלי לנסות פנייה רשתית כלשהי");
    const yemotAuthVerifyResult = await yemotAuth.verifyCallerIdCode("+972500000001", "1234");
    assert(yemotAuthVerifyResult === false, "verifyCallerIdCode() מחזיר false במצב לא-מוגדר, בלי לנסות פנייה רשתית כלשהי");
    assert(
      ymSignupGreeting.includes(",no,voice,") && !ymSignupGreeting.includes(",no,record,"),
      "כשלא מוגדר זיהוי דיבור משודרג, שלב טקסט חופשי בימות (שם בהרשמה) עדיין משתמש במנוע ה-STT הרגיל של ימות ולא במצב הקלטה גולמית"
    );
    // תוקן (ארכיטקטורת שלוחת הקלטה נפרדת): בדיקת יחידה על הפורמט המדויק של פקודת המעבר לשלוחה -
    // לא ניתן לבדוק את מלוא הזרימה מקצה-לקצה כאן (דורש קו ימות אמיתי, ר' README), אבל לפחות מוודאים
    // שהמחרוזת שנשלחת לימות תואמת בדיוק לתחביר g-/<שלוחה> המתועד (כמו sayAndHangup, עם g-hangup).
    const { sayAndGoToRecordExtension } = require("../src/services/yemot");
    assert(
      sayAndGoToRecordExtension("מה שמך", "2") === "id_list_message=t-מה שמך.g-/2",
      "sayAndGoToRecordExtension בונה פקודת מעבר-שלוחה בפורמט id_list_message=t-<טקסט>.g-/<שלוחה> - כמו sayAndHangup, עם יעד שלוחה במקום hangup"
    );
    // תוקן (באג אמיתי שהתגלה בבדיקה חיה - ר' README): רשת הביטחון שמזהה תמלול "מוזה" בכתב לא-עברי
    // (Whisper החזיר בפועל "Conchód"/"Холхот"/"خونخود" במקום "חונכות" בעברית) - containsHebrew.
    assert(
      speechToText.containsHebrew("שלום שטיינברג") === true,
      "containsHebrew מזהה נכון טקסט עברי תקין"
    );
    assert(
      speechToText.containsHebrew("Conchód.") === false && speechToText.containsHebrew("Холхот") === false && speechToText.containsHebrew("خونخود") === false,
      "containsHebrew מזהה נכון תמלול 'מוזה' בכתב לטיני/קירילי/ערבי (בלי אף אות עברית) - כמו שנצפה בפועל בבדיקה חיה עם gpt-4o-mini-transcribe"
    );

    console.log("\n🔢 גם כשה-Whisper פעיל, תפריט הראשי ('ניהול חשבונות'/'חונכות' וכו') נשאר עם קיצור הקשה");
    // משוב אמיתי ממשתמש בבדיקה חיה: "קטגוריית ניהול חשבון חונכות השארת רק בזיהוי דיבור, אני צריך
    // אופציה של הקשות" - מדמים Whisper פעיל (בלי מפתחות אמיתיים) ומוודאים ש-main_menu/balance_next_action
    // לא עוברים לשלוחת ההקלטה הנפרדת (שם ימות חוסמת הקשות), בעוד ששלבי טקסט חופשי אמיתיים (כמו שם
    // בהרשמה) כן ממשיכים ליהנות מדיוק ה-Whisper כרגיל.
    const yemotRoutes = require("../src/routes/yemot");
    assert(
      yemotRoutes.MENU_DIGIT_FREE_TEXT_STATES.has("main_menu") && yemotRoutes.MENU_DIGIT_FREE_TEXT_STATES.has("balance_next_action"),
      "MENU_DIGIT_FREE_TEXT_STATES כולל את שני השלבים עם קיצור הקשה שימושי: תפריט ראשי, ותפריט אחרי יתרה"
    );
    // הערה: הבדיקות כאן מריצות את השרת האמיתי כתהליך-בן נפרד (child_process.spawn, ר' תחילת הקובץ) -
    // "זיוף" isConfigured() בתהליך הבדיקות עצמו לא משפיע על תהליך השרת שמטפל בפועל בבקשות ה-HTTP, אז
    // לא ניתן לבדוק כאן את תגובת הפרוטוקול המלאה מקצה-לקצה בלי להקים שרת-בדיקה נפרד עם משתני סביבה
    // מזויפים (וסיכון לנסות פנייה רשתית אמיתית ל-OpenAI). לכן בודקים ישירות את לוגיקת ה-shouldUseRecordExtension
    // המיוצאת - זו הפונקציה היחידה שקובעת את ההתנהגות הזו, אז בדיקת יחידה עליה מכסה את התיקון במלואו.
    const originalIsConfigured = speechToText.isConfigured;
    speechToText.isConfigured = () => true; // מדמים Whisper פעיל, בלי לגעת במשתני הסביבה האמיתיים
    try {
      assert(
        yemotRoutes.shouldUseRecordExtension("main_menu") === false && yemotRoutes.shouldUseRecordExtension("balance_next_action") === false,
        "גם כש-Whisper פעיל, main_menu ו-balance_next_action לא עוברים לשלוחת ההקלטה - קיצור ההקשה (1-6, 1/2) נשאר זמין"
      );
      assert(
        yemotRoutes.shouldUseRecordExtension("signup_name") === true && yemotRoutes.shouldUseRecordExtension("therapist_note") === true,
        "שלבי טקסט חופשי אמיתיים (שם בהרשמה, תוכן דיווח) עדיין עוברים לשלוחת ההקלטה כשה-Whisper פעיל, כי אין בהם קיצור הקשה להפסיד"
      );
    } finally {
      speechToText.isConfigured = originalIsConfigured; // חובה להחזיר, כדי לא להשפיע על שאר הבדיקות
    }
    assert(speechToText.isConfigured() === false, "אחרי שחזור isConfigured() המקורי, שאר הבדיקות ממשיכות לרוץ במצב MOCK הרגיל");
    assert(
      yemotRoutes.shouldUseRecordExtension("main_menu") === false && yemotRoutes.shouldUseRecordExtension("signup_name") === false,
      "כש-Whisper לא פעיל (מצב הבדיקות הרגיל), אף שלב לא עובר לשלוחת ההקלטה - כולם נשארים במצב voice רגיל"
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
