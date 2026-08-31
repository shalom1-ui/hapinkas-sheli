// recurringCharges.js — כרטיסי אשראי / הוראות קבע חוזרים, עם התראת מייל לפני תאריך החיוב. משוב
// אמיתי: "יש לאנשים כרטיסי אשראי שכל כרטיס יוצא בתאריך אחר או הו"ק בבנק, חשוב לי שאיש יקבל התראה
// לפני התאריך כמה כסף הוא צריך להכניס לבנק". שאלות הבהרה שנשאלו והמשתמש ענה עליהן:
//   - איך מגדירים "מחויב"? מסך חדש: שם + יום קבוע בחודש.
//   - מאיפה מגיע הסכום המוצג? לא מוזן ידנית - קישור לקטגוריה בתנועות הרגילות, ממוצע 3 חודשים אחרונים.
//   - ערוץ ההתראה? מייל (יש כבר SendGrid מוגדר, ר' services/email.js).
//   - כמה זמן מראש כברירת מחדל? 3 ימים.
//   - מנגנון תזמון יומי? אין תשתית cron בתוך השרת עצמו - נחשף נתיב מוגן (/api/system/charge-reminders/run)
//     שמיועד להיקרא פעם ביום ע"י Render Cron Job חיצוני (ר' README, "התראות לפני חיוב כרטיס/הו"ק").
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");
const { sendEmail } = require("../services/email");

// מספר הימים בחודש נתון (month: 1-12) - new Date(year, month, 0) "גולש" ליום האחרון של החודש הקודם,
// כלומר בפועל היום האחרון של month.
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// התאריך (Date, חצות UTC) של החיוב הבא בפועל, החל מ-fromDate (כולל, אם fromDate עצמו הוא יום
// החיוב). אם charge_day גדול ממספר הימים בחודש (למשל 31 בפברואר) - "נצמד" ליום האחרון של אותו
// חודש בפועל, ולא גולש לחודש הבא - כך שכרטיס שמוגדר ליום 31 בכל זאת מקבל תזכורת פעם בחודש.
function nextChargeDate(chargeDay, fromDate) {
  let year = fromDate.getUTCFullYear();
  let month = fromDate.getUTCMonth() + 1; // 1-12
  let day = Math.min(chargeDay, daysInMonth(year, month));
  let candidate = Date.UTC(year, month - 1, day);
  if (candidate < fromDate.getTime()) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    day = Math.min(chargeDay, daysInMonth(year, month));
    candidate = Date.UTC(year, month - 1, day);
  }
  return new Date(candidate);
}

function todayUtcMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// הערכת סכום החיוב - ממוצע הוצאות בפועל תחת אותה קטגוריה, 3 החודשים האחרונים. count=0 (אין עדיין
// תנועות תואמות) לא מוצג כ-"₪0" מטעה - הצד הקורא (כאן ובתשובת ה-API) בודק את זה בנפרד ומציג הודעה
// ברורה ("אין עדיין מספיק נתונים") במקום מספר שגוי. moved_to IS NULL - כמו כל חישוב סכום אחר
// בפרויקט (ר' routes/transactions.js) - תנועה שהועברה לחתונה/דירה כבר נספרת שם, לא כאן.
function estimateAmount(userId, category) {
  if (!category) return { avg: null, count: 0 };
  const row = db
    .prepare(
      `SELECT AVG(amount) AS avg, COUNT(*) AS count FROM transactions
       WHERE user_id = ? AND category = ? AND type = 'expense' AND moved_to IS NULL
       AND occurred_at >= datetime('now', '-3 months')`
    )
    .get(userId, category);
  return { avg: row.avg !== null ? Math.round(row.avg * 100) / 100 : null, count: row.count };
}

function withEstimate(charge) {
  const { avg, count } = estimateAmount(charge.user_id, charge.category);
  return {
    ...charge,
    estimatedAmount: avg,
    estimatedFromCount: count,
    nextChargeDate: isoDate(nextChargeDate(charge.charge_day, todayUtcMidnight())),
  };
}

function validateFields(body, fallback) {
  const name = body.name !== undefined ? String(body.name || "").trim().slice(0, 200) : fallback.name;
  if (!name) return { error: "יש להזין שם (למשל 'כרטיס ויזה' או 'הו\"ק ארנונה')" };
  const chargeDay = body.charge_day !== undefined ? Number(body.charge_day) : fallback.charge_day;
  if (!Number.isInteger(chargeDay) || chargeDay < 1 || chargeDay > 31) return { error: "יש להזין יום בחודש תקין (1 עד 31)" };
  // ?? null (לא רק ?:) - fallback ל-POST הוא {} (אין שדות), אז fallback.category הוא undefined, לא
  // null - ו-node:sqlite זורק שגיאה על ניסיון לכרוך פרמטר undefined (רק null/מספר/מחרוזת מותרים,
  // בדיוק כמו monthlyAmount/note ב-routes/loans.js) - בלי זה, יצירת מחויב בלי קטגוריה נכשלה בשקט.
  const category = (body.category !== undefined ? (body.category ? String(body.category).trim().slice(0, 100) : null) : fallback.category) ?? null;
  const reminderDaysBefore = body.reminder_days_before !== undefined ? Number(body.reminder_days_before) : (fallback.reminder_days_before ?? 3);
  if (!Number.isInteger(reminderDaysBefore) || reminderDaysBefore < 0 || reminderDaysBefore > 30) {
    return { error: "מספר ימי ההתראה מראש חייב להיות בין 0 ל-30" };
  }
  return { name, chargeDay, category, reminderDaysBefore };
}

// נתיב "הרצת התראות" יומי - מוגן במילת-מעבר קבועה בפרמטר key (בדיוק כמו /api/debug/yemot-dir
// הקיים), לא JWT רגיל - כי הקורא כאן הוא Render Cron Job חיצוני, לא משתמש מחובר. עובר על *כל*
// המשתמשים וכל המחויבים שלהם (לא requireAuth של משתמש בודד) - בכוונה נתיב נפרד, לא מוצמד לשום
// requireAuth קיים.
const CRON_KEY = "hapinkas-charges-cron-5817";

async function runReminderCheck() {
  const today = todayUtcMidnight();
  const users = db.prepare("SELECT id, email, full_name, budget_alerts FROM users").all();
  let checked = 0;
  let remindersSent = 0;
  let usersNotified = 0;
  const errors = [];

  for (const user of users) {
    // budget_alerts (ר' db.js/routes/auth.js) - אותו מתג "לקבל התראות תקציב" שכבר קיים במסך
    // ההגדרות - לא נשלח מייל למי שכיבה אותו, ולא בלי כתובת מייל רשומה בכלל.
    if (!user.budget_alerts || !user.email) continue;

    const charges = db.prepare("SELECT * FROM recurring_charges WHERE user_id = ?").all(user.id);
    const dueToday = [];
    for (const charge of charges) {
      checked++;
      const nextDate = nextChargeDate(charge.charge_day, today);
      const daysUntil = Math.round((nextDate.getTime() - today.getTime()) / 86400000);
      const nextDateIso = isoDate(nextDate);
      if (daysUntil === charge.reminder_days_before && charge.last_reminder_sent_for !== nextDateIso) {
        const { avg, count } = estimateAmount(user.id, charge.category);
        dueToday.push({ charge, nextDateIso, avg, count });
      }
    }
    if (!dueToday.length) continue;

    const lines = dueToday.map(({ charge, nextDateIso, avg, count }) => {
      const amountText = count > 0 ? `כ-₪${avg} (הערכה לפי ${count} תנועות אחרונות)` : "אין עדיין מספיק נתונים להערכת סכום";
      return `• ${charge.name} - חיוב ב-${nextDateIso} - ${amountText}`;
    });
    const knownTotal = dueToday.filter(d => d.count > 0).reduce((s, d) => s + d.avg, 0);
    const totalLine = dueToday.some(d => d.count > 0)
      ? `\nסה"כ מוערך שכדאי שיהיה בבנק: ₪${Math.round(knownTotal * 100) / 100}`
      : "";

    try {
      await sendEmail({
        to: user.email,
        subject: dueToday.length === 1 ? `תזכורת: ${dueToday[0].charge.name} מתקרב` : `תזכורת: ${dueToday.length} חיובים מתקרבים`,
        body: `שלום ${user.full_name},\n\nמתקרבים החיובים הבאים:\n\n${lines.join("\n")}${totalLine}\n\nבברכה,\nהפנקס שלי`,
      });
      for (const { charge, nextDateIso } of dueToday) {
        db.prepare("UPDATE recurring_charges SET last_reminder_sent_for = ? WHERE id = ?").run(nextDateIso, charge.id);
        remindersSent++;
      }
      usersNotified++;
    } catch (e) {
      errors.push({ userId: user.id, error: e.message });
    }
  }

  return { checked, remindersSent, usersNotified, errors };
}

function register(router) {
  router.get("/api/recurring-charges", requireAuth(async (ctx) => {
    const rows = db.prepare("SELECT * FROM recurring_charges WHERE user_id = ? ORDER BY charge_day, id").all(ctx.user.userId);
    return json(ctx.res, 200, { charges: rows.map(withEstimate) });
  }));

  router.post("/api/recurring-charges", requireAuth(async (ctx) => {
    const v = validateFields(ctx.body, {});
    if (v.error) return json(ctx.res, 400, { error: v.error });
    const info = db
      .prepare("INSERT INTO recurring_charges (user_id, name, charge_day, category, reminder_days_before) VALUES (?, ?, ?, ?, ?)")
      .run(ctx.user.userId, v.name, v.chargeDay, v.category, v.reminderDaysBefore);
    const row = db.prepare("SELECT * FROM recurring_charges WHERE id = ?").get(info.lastInsertRowid);
    return json(ctx.res, 201, { charge: withEstimate(row) });
  }));

  router.put("/api/recurring-charges/:id", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM recurring_charges WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "מחויב חוזר לא נמצא" });
    const v = validateFields(ctx.body, row);
    if (v.error) return json(ctx.res, 400, { error: v.error });
    db.prepare("UPDATE recurring_charges SET name = ?, charge_day = ?, category = ?, reminder_days_before = ? WHERE id = ?")
      .run(v.name, v.chargeDay, v.category, v.reminderDaysBefore, row.id);
    const updated = db.prepare("SELECT * FROM recurring_charges WHERE id = ?").get(row.id);
    return json(ctx.res, 200, { charge: withEstimate(updated) });
  }));

  router.delete("/api/recurring-charges/:id", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM recurring_charges WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "מחויב חוזר לא נמצא" });
    db.prepare("DELETE FROM recurring_charges WHERE id = ?").run(row.id);
    return json(ctx.res, 200, { message: "נמחק" });
  }));

  // נקרא פעם ביום ע"י Render Cron Job חיצוני (ר' README) - לא ע"י המשתמש/הממשק בכלל.
  router.get("/api/system/charge-reminders/run", async (ctx) => {
    if (ctx.query.key !== CRON_KEY) return json(ctx.res, 403, { error: "אין הרשאה - חסר או שגוי פרמטר key" });
    const result = await runReminderCheck();
    return json(ctx.res, 200, result);
  });
}

module.exports = { register, nextChargeDate, estimateAmount, runReminderCheck };
