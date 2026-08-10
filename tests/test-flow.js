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

    console.log("\n🔑 שחזור סיסמה בשיחה קולית (ללא SMS)");
    const fpReq = await api("POST", "/api/auth/forgot-password/request", { username, channel: "phone" });
    assert(fpReq.status === 200 && fpReq.data.demoCode, "בקשת שחזור סיסמה החזירה קוד דמו (מצב MOCK)");
    const fpVerify = await api("POST", "/api/auth/forgot-password/verify", { username, code: fpReq.data.demoCode });
    assert(fpVerify.status === 200 && fpVerify.data.resetToken, "אימות קוד השחזור הצליח");
    const fpReset = await api("POST", "/api/auth/forgot-password/reset", { resetToken: fpVerify.data.resetToken, newPassword: "9999" });
    assert(fpReset.status === 200, "קביעת סיסמה חדשה הצליחה");
    const loginNew = await api("POST", "/api/auth/login", { username, password: "9999" });
    assert(loginNew.status === 200, "התחברות עם הסיסמה החדשה הצליחה");

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
    assert(addGuardianByStranger.status === 404, "משתמש זר (שאינו בעלים) לא יכול לשייך הורה לתלמיד");

    const addGuardian = await api("POST", `/api/students/${sid}/guardians`, { username: parentUsername }, token);
    assert(addGuardian.status === 201, "החונך (הבעלים) שייך בהצלחה הורה לתלמיד");

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

    console.log("\n📞 מנוע השיחה הקולית (IVR) — ללא לחיצת מקשים, הכל בדיבור חופשי");
    const callSid = `TEST-${Date.now()}`;
    const greeting = await ivrCall(callSid, "+972500000001");
    assert(greeting.includes("<Gather") && greeting.includes("אפשר לומר"), "פתיחת שיחה מזהה משתמש ומציגה תפריט");

    const unknownCall = await ivrCall(`${callSid}-unknown`, "+972500000099");
    assert(unknownCall.includes("אינו מזוהה"), "שיחה ממספר לא רשום נדחית כראוי");

    await ivrSay(callSid, "הוצאה");
    await ivrSay(callSid, "60");
    await ivrSay(callSid, "תחבורה");
    const confirmXml = await ivrSay(callSid, "כן");
    assert(confirmXml.includes("נשמר"), "זרימת הוצאה קולית מלאה הושלמה ואושרה");

    const afterCallTx = await api("GET", "/api/transactions", null, token);
    const phoneTx = afterCallTx.data.transactions.find(t => t.source === "phone" && t.amount === 60);
    assert(!!phoneTx, "התנועה שנוצרה בשיחה הקולית אכן נשמרה במסד הנתונים עם source=phone");

    const balanceCallSid = `${callSid}-balance`;
    await ivrCall(balanceCallSid, "+972500000001");
    const balanceXml = await ivrSay(balanceCallSid, "יתרה");
    assert(balanceXml.includes("היתרה הנוכחית שלך היא"), "שאילתת יתרה קולית עובדת");

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
