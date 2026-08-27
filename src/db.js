// db.js — שכבת מסד הנתונים.
// משתמש ב-node:sqlite המובנה ב-Node.js (מגרסה 22.5 ומעלה) — אין צורך בהתקנת שום חבילה חיצונית.
// לפריסה בקנה מידה גדול יותר בעתיד ניתן להחליף בקלות ל-PostgreSQL (מבנה הטבלאות תואם).
"use strict";

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "app.db");
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    phone TEXT,
    phone2 TEXT,
    email TEXT,
    voice_pin TEXT,                    -- קוד זיהוי קולי לשימוש כאשר Caller ID לא מזוהה
    roles TEXT NOT NULL DEFAULT 'private', -- comma-separated: private,mentor,therapist,supervisor,admin
    default_session_minutes INTEGER DEFAULT 45,
    budget_alerts INTEGER DEFAULT 1,
    signup_channel TEXT NOT NULL DEFAULT 'web', -- 'web' (נרשם באתר בעצמו, עם סיסמה שבחר) | 'phone' (נוצר אוטומטית מהטלפון)
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,               -- 'basic' | 'pro'
    name TEXT NOT NULL,
    price INTEGER NOT NULL,            -- ₪ לחודש
    features TEXT NOT NULL             -- JSON array
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    plan_id TEXT NOT NULL REFERENCES plans(id),
    status TEXT NOT NULL DEFAULT 'active', -- active | trial | past_due | canceled
    started_at TEXT DEFAULT (datetime('now')),
    next_billing_date TEXT,
    cardcom_recurring_id TEXT          -- מזהה הוראת הקבע אצל Cardcom (כשמחובר לאמת)
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    channel TEXT NOT NULL,             -- phone | email
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    -- 'yemot' אם הקוד נשלח בפועל בשיחת אימות חינמית דרך ימות (ר' services/yemotAuth.js) - במקרה כזה
    -- האימות בפועל מתבצע מול ימות עצמם (VerifyCode), לא מול code_hash כאן. NULL = כרגיל, מול code_hash.
    verify_via TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,                -- income | expense
    amount REAL NOT NULL,
    category TEXT,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'web',-- phone | web | import
    -- טביעת-אצבע (hash) של תנועה שיובאה מקובץ אקסל/CSV (ר' routes/importTransactions.js) - מאפשרת
    -- לזהות ולדלג על תנועות שכבר יובאו בעבר אם אותו קובץ (או קובץ חופף) מועלה שוב. NULL לתנועות
    -- רגילות (טלפון/אתר) שלא הגיעו מייבוא.
    import_hash TEXT,
    -- מזהה "אצווה" (batch) - כל התנועות שנשמרו יחד מאותה קריאת /import/commit (כלומר מאותה העלאת
    -- קובץ) מקבלות אותו מזהה. מאפשר למחוק בבת אחת "את כל מה שהובא מהקובץ הזה" (ר' משוב אמיתי:
    -- "אם הבאתי דפי בנק ואני רוצה למחוק את הקבצים שהועלו"), במקום למחוק תנועה-תנועה. NULL לתנועות
    -- רגילות (טלפון/אתר) שלא הגיעו מייבוא.
    import_batch_id TEXT,
    import_filename TEXT,
    occurred_at TEXT DEFAULT (datetime('now'))
  );

  -- תקציב חתונה - אזור נפרד לגמרי מהתנועות הרגילות (לא מעורבב עם income/expense של transactions),
  -- לפי משוב אמיתי: "שתהיה קטגוריה נפרדת להוצאות חתונה, הכנסות מתרומות" + בקשה מפורשת ל"אזור נפרד
  -- לגמרי". קטגוריות ההוצאה קבועות מראש (ר' WEDDING_EXPENSE_CATEGORIES ב-routes/weddingTransactions.js)
  -- כולל פירוט לפי יום עבור שבע ברכות. אפשר גם לערוך תנועה קיימת (לא רק למחוק) - ר' PUT באותו קובץ.
  CREATE TABLE IF NOT EXISTS wedding_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,                -- income | expense
    amount REAL NOT NULL,
    category TEXT,
    note TEXT,
    occurred_at TEXT DEFAULT (datetime('now'))
  );

  -- תקציב דירה - אזור נפרד לגמרי, באותו דגם בדיוק כמו wedding_transactions (ר' שם). משוב אמיתי:
  -- "אני צריך שיהיה שני קטגוריות נפרדות: 1 חתונה, 2 דירה. בתוך דירה יש שני אפשרויות רגיל, תבע משותף".
  CREATE TABLE IF NOT EXISTS apartment_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,                -- income | expense
    amount REAL NOT NULL,
    category TEXT,
    note TEXT,
    occurred_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id), -- מי יצר/מנהל את התלמיד (חונך/מטפל ראשי)
    name TEXT NOT NULL,
    contact_info TEXT,
    active INTEGER DEFAULT 1,
    checkin_at TEXT,                   -- אם יש מפגש פתוח (צ'ק-אין) - חותמת הזמן
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id),
    mentor_user_id INTEGER NOT NULL REFERENCES users(id),
    method TEXT NOT NULL,              -- checkin_checkout | quick_preset
    duration_minutes INTEGER NOT NULL,
    linked_transaction_id INTEGER REFERENCES transactions(id),
    note TEXT,                         -- דיווח מעקב חופשי של החונך על המפגש (אופציונלי)
    occurred_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS therapy_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id),
    professional_user_id INTEGER NOT NULL REFERENCES users(id),
    role_type TEXT NOT NULL,           -- ריפוי בעיסוק | טיפול רגשי | אחר
    note TEXT NOT NULL,
    trend TEXT NOT NULL,               -- משתפרת | יציבה | דורשת תשומת לב
    transcript TEXT,                   -- תמלול מקורי מהשיחה הקולית (אם רלוונטי)
    occurred_at TEXT DEFAULT (datetime('now'))
  );

  -- "הכנה לשיעור" - טופס חונכות מובנה (דיגיטציה של הטופס הנייר ששלח המשתמש), בנוסף למפגש הרגיל.
  -- כל השדות למעט student_id/mentor_user_id הם אופציונליים ובניסוח חופשי - הרשימה כאן היא רק מבנה השדות/הכותרות מהטופס המקורי.
  CREATE TABLE IF NOT EXISTS lesson_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id),
    mentor_user_id INTEGER NOT NULL REFERENCES users(id),
    lesson_date TEXT,                  -- תאריך (חופשי - יכול להיות תאריך עברי כמו "יג כסלו")
    teacher_name TEXT,                 -- שם המלמד
    teacher_phone TEXT,
    convenient_hours TEXT,             -- שעות נוחות להתקשר
    study_days TEXT,                   -- ימי לימוד
    guidance_date TEXT,                -- תאריך הדרכה
    reassessment_recommendation TEXT,  -- המלצה להערכה חוזרת
    reassessment_date TEXT,            -- תאריך הערכה חוזרת
    week_number INTEGER,               -- מס' שבוע
    meeting_number INTEGER,            -- מס' פגישה
    study_duration_minutes INTEGER,    -- זמן לימוד
    topic_studied TEXT,                -- הקטע הנלמד בשיעור
    goal TEXT,                         -- מטרה
    work_method TEXT,                  -- צורת עבודה
    practical_application TEXT,        -- יישום בפועל / העברת החומר בפועל
    connection_cooperation TEXT,       -- התחברות ושיתוף פעולה
    coping_achieving_goals TEXT,       -- התמודדות והשגת המטרות
    environment_comments TEXT,         -- הערות מהסביבה
    lateness TEXT,                     -- איחורים
    absences TEXT,                     -- וחיסורים
    occurred_at TEXT DEFAULT (datetime('now'))
  );

  -- מסמכים/קבצים שהועלו למערכת (למשל טופס "הכנה לשיעור" הסרוק/מקורי, או כל מסמך אחר) -
  -- מאוחסן בפועל בדיסק (ר' routes/documents.js), וכאן רק המטא-דאטה + נתיב הקובץ. ברשימה מוצג רק הכותרת (title).
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id),
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,               -- הכותרת שמוצגת ברשימה
    filename TEXT NOT NULL,            -- שם הקובץ המקורי
    mime_type TEXT,
    size_bytes INTEGER,
    file_path TEXT NOT NULL,           -- נתיב יחסי בתוך data/uploads
    uploaded_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS student_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id),
    author_user_id INTEGER REFERENCES users(id),
    author_label TEXT NOT NULL,        -- שם/תפקיד לתצוגה (יכול לכלול "דרך השיחה הקולית")
    text TEXT NOT NULL,
    occurred_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS student_guardians (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id),
    guardian_user_id INTEGER NOT NULL REFERENCES users(id), -- ההורה - יכול לראות רק סיכומים, לא את הצ'אט הפנימי
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(student_id, guardian_user_id)
  );

  -- "מילון" ניסוחים חופשיים שאיש מקצוע כתב בעבר (תוכן דיווח / מגמה מותאמת-אישית תחת "אחר") -
  -- מוצע לו כהשלמה אוטומטית (autocomplete) בפעם הבאה עם תלמיד אחר, כדי לא להקליד מחדש כל פעם.
  CREATE TABLE IF NOT EXISTS phrase_dictionary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professional_user_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,                -- 'note' | 'trend'
    text TEXT NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 1,
    last_used_at TEXT DEFAULT (datetime('now')),
    UNIQUE(professional_user_id, kind, text)
  );

  CREATE TABLE IF NOT EXISTS call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    call_sid TEXT UNIQUE,
    state TEXT,               -- שם הצומת הנוכחי בשיחה הקולית (מכונת מצבים)
    draft_json TEXT,          -- נתונים שנאספו עד כה בשיחה הנוכחית (JSON) - למשל סכום/קטגוריה טרם אישור
    transcript TEXT,          -- תמלול מצטבר של מה שהמשתמש אמר במהלך השיחה
    outcome TEXT,             -- מה קרה בסוף השיחה (למשל "expense_saved", "hangup_unidentified")
    occurred_at TEXT DEFAULT (datetime('now'))
  );

  -- בקשות אישור לתפקיד "מפקח" - תפקיד רגיש (גישה לצ'אט הפנימי/דוחות של כל תלמיד, לא רק תלמידים
  -- שרשמת בעצמך) ולכן אי אפשר "להצהיר" עליו לבד כמו על חונך/מטפל - חייבים אישור בעל הקו (admin):
  -- מי שמבקש להיות מפקח מזין את מספר הטלפון של בעל הקו, ונשלח קוד בן 4 ספרות למייל של בעל הקו -
  -- בעל הקו מעביר את הקוד (בעל פה/בטלפון) למי שביקש, שמזין אותו כדי לאשר בפועל.
  CREATE TABLE IF NOT EXISTS role_upgrade_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id), -- מי מבקש להפוך למפקח
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- אימות תביעת "בעל הקו" (admin) - ר' src/routes/auth.js (/api/me/request-admin-claim,
  -- /api/me/confirm-admin-claim) להסבר המלא על התהליך. בכוונה לא "המשתמש הראשון שנרשם" (יכול
  -- להיות חשבון שנוצר אוטומטית מהטלפון, בלי סיסמה שנבחרה בפועל) - אלא מי שנרשם באתר עצמו
  -- (signup_channel='web') ומאמת בפועל שהוא הבעלים של הטלפון הרשום שלו, דרך קוד בשיחה קולית.
  CREATE TABLE IF NOT EXISTS admin_claim_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    verify_via TEXT,                   -- 'yemot' אם נשלח בשיחת אימות חינמית דרך ימות - ר' הערה ב-password_resets למעלה
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// מיגרציה קטנה: אם יש כבר קובץ מסד נתונים ישן (מלפני שנוספו העמודות/הטבלאות האלה),
// CREATE TABLE IF NOT EXISTS למעלה לא מוסיף עמודה לטבלה קיימת - צריך ALTER TABLE בנפרד.
for (const alterSql of [
  "ALTER TABLE sessions ADD COLUMN note TEXT",
  "ALTER TABLE users ADD COLUMN signup_channel TEXT NOT NULL DEFAULT 'web'",
  // תוקן (ארכיטקטורת שלוחת הקלטה נפרדת בימות, ר' routes/yemot.js): צריך "phone" ו-"updated_at"
  // כדי לאתר מחדש שיחה שהועברה זמנית לשלוחת ההקלטה, למקרה ש-ApiCallId משתנה במעבר בין שלוחות
  // (לא מתועד במפורש - ר' הערה מפורטת ב-routes/yemot.js/reattachRecordingCall).
  "ALTER TABLE call_logs ADD COLUMN phone TEXT",
  "ALTER TABLE call_logs ADD COLUMN updated_at TEXT",
  // אימות טלפוני חינמי דרך ימות (ר' services/yemotAuth.js) - ר' הערה מפורטת ב-CREATE TABLE למעלה.
  "ALTER TABLE password_resets ADD COLUMN verify_via TEXT",
  "ALTER TABLE admin_claim_requests ADD COLUMN verify_via TEXT",
  // "ייבוא אקסל" (ר' routes/importTransactions.js) - זיהוי כפילויות בין ייבוא לייבוא.
  "ALTER TABLE transactions ADD COLUMN import_hash TEXT",
  // מחיקת קובץ ייבוא שלם בבת אחת (ר' routes/importTransactions.js) - ר' הערה מפורטת ב-CREATE TABLE למעלה.
  "ALTER TABLE transactions ADD COLUMN import_batch_id TEXT",
  "ALTER TABLE transactions ADD COLUMN import_filename TEXT",
]) {
  try {
    db.exec(alterSql);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e; // מתעלמים רק אם העמודה כבר קיימת
  }
}

// אינדקס ייחודי חלקי (רק על שורות עם import_hash) - חוסם כפילויות מייבוא באופן אמין גם אם שתי
// בקשות /api/transactions/import/commit רצות בו-זמנית (בדיקת "האם כבר קיים" באפליקציה לבדה לא
// מספיקה נגד מרוץ תזמון - ר' routes/importTransactions.js).
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_import_hash ON transactions(user_id, import_hash) WHERE import_hash IS NOT NULL");
} catch (e) {
  console.error("שגיאה ביצירת אינדקס import_hash (לא קריטי - בדיקת הכפילות באפליקציה עדיין פעילה):", e.message);
}

// זריעת תוכניות ברירת מחדל אם עדיין לא קיימות
const planCount = db.prepare("SELECT COUNT(*) AS c FROM plans").get().c;
if (planCount === 0) {
  const insertPlan = db.prepare("INSERT INTO plans (id, name, price, features) VALUES (?, ?, ?, ?)");
  insertPlan.run("basic", "תרומה בסיסית", 15, JSON.stringify([
    "ניהול תקציב אישי מלא", "שיחה קולית חופשית ללא הגבלה", "דיווח מפגשי חונכות",
  ]));
  insertPlan.run("pro", "תרומה מורחבת", 29, JSON.stringify([
    "כל מה שכלול בתוכנית הבסיסית", "מעגל מטפלים + תיק תלמיד מאוחד", "ייצוא דוחות מתקדם", "תמיכה מועדפת",
  ]));
}

module.exports = db;
