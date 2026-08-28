// loans.js — מעקב הלוואות בתשלומים. משוב אמיתי: "כל חודש כשאני מגיע לפנקס... שיהיה חישוב אוטומטי
// אם יש הלוואות בתשלומים כל חודש שיתעדכן כמה תשלומים נשאר". לשאלת הבהרה בין "רשומה ייעודית
// להלוואות" (עם חישוב אוטומטי לפי חודשים שחלפו) לבין "קישור לתנועות 'הלוואות' קיימות" - המשתמש ענה
// "גם וגם", אז שתי הדרכים ממומשות ביחד: כל הלוואה נרשמת פעם אחת (שם/מס' תשלומים/סכום חודשי/תאריך
// תשלום ראשון), ו"כמה תשלומים בוצעו" מחושב כך: אם יש תנועות שקושרו בפועל להלוואה הזו (ר' loan_id
// ב-transactions/wedding_transactions/apartment_transactions - נקבע כשמוסיפים תנועת "הלוואות"
// ובוחרים לקשר אותה) - סופרים אותן (המספר האמיתי). אחרת (עדיין לא קושרה אף תנועה) - מעריכים לפי
// כמה חודשים חלפו מתאריך ההתחלה, אוטומטית, בלי שהמשתמש יצטרך לעדכן ידנית כל חודש.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");

// כמה "חודשי תשלום" חלפו מאז תאריך ההתחלה (כולל התשלום של חודש ההתחלה עצמו כתשלום #1). אם עוד לא
// הגיע היום-בחודש המקביל לתאריך ההתחלה, לא סופרים את החודש הנוכחי עדיין (התשלום עוד לא "הגיע").
function monthsElapsedSinceStart(startDateStr) {
  const start = new Date(startDateStr + "T00:00:00");
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  return months + 1;
}

function countLinkedPayments(userId, loanId) {
  const tables = ["transactions", "wedding_transactions", "apartment_transactions"];
  return tables.reduce((sum, table) => {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ? AND loan_id = ?`).get(userId, loanId);
    return sum + row.c;
  }, 0);
}

function withProgress(loan, userId) {
  const linkedPaymentsCount = countLinkedPayments(userId, loan.id);
  const estimatedByDate = Math.max(0, Math.min(loan.total_installments, monthsElapsedSinceStart(loan.start_date)));
  const paidInstallments = linkedPaymentsCount > 0 ? Math.min(linkedPaymentsCount, loan.total_installments) : estimatedByDate;
  return {
    ...loan,
    linkedPaymentsCount,
    estimatedByDate,
    paidInstallments,
    remainingInstallments: Math.max(0, loan.total_installments - paidInstallments),
  };
}

function validateLoanFields(body, fallback) {
  const name = body.name !== undefined ? String(body.name || "").trim().slice(0, 200) : fallback.name;
  if (!name) return { error: "יש להזין שם להלוואה" };
  const totalInstallments = body.total_installments !== undefined ? Number(body.total_installments) : fallback.total_installments;
  if (!Number.isFinite(totalInstallments) || totalInstallments <= 0) return { error: "יש להזין מספר תשלומים תקין" };
  const startDate = body.start_date !== undefined ? body.start_date : fallback.start_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ""))) return { error: "יש להזין תאריך תשלום ראשון תקין" };
  // ?? null (לא רק ?:) - fallback ל-POST הוא {} (אין שדות), אז fallback.monthly_amount/fallback.note
  // הם undefined, לא null - ו-node:sqlite זורק שגיאה על ניסיון לכרוך פרמטר undefined (רק null/מספר/
  // מחרוזת/buffer מותרים). זה תוקן כאן כי זו הפעם הראשונה שנתקלנו בזה - שאר הנתיבים תמיד קיבלו את
  // ה-fallback משורה קיימת מה-DB (לעולם לא undefined בפועל, source NULL כבר).
  const monthlyAmount = (body.monthly_amount !== undefined
    ? (body.monthly_amount ? Number(body.monthly_amount) : null)
    : fallback.monthly_amount) ?? null;
  const note = (body.note !== undefined ? (body.note ? String(body.note).trim().slice(0, 500) : null) : fallback.note) ?? null;
  return { name, totalInstallments: Math.round(totalInstallments), startDate, monthlyAmount, note };
}

function register(router) {
  router.get("/api/loans", requireAuth(async (ctx) => {
    const rows = db.prepare("SELECT * FROM loans WHERE user_id = ? ORDER BY created_at DESC, id DESC").all(ctx.user.userId);
    return json(ctx.res, 200, { loans: rows.map(l => withProgress(l, ctx.user.userId)) });
  }));

  router.post("/api/loans", requireAuth(async (ctx) => {
    const v = validateLoanFields(ctx.body, {});
    if (v.error) return json(ctx.res, 400, { error: v.error });
    const info = db.prepare(
      "INSERT INTO loans (user_id, name, total_installments, monthly_amount, start_date, note) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(ctx.user.userId, v.name, v.totalInstallments, v.monthlyAmount, v.startDate, v.note);
    const loan = db.prepare("SELECT * FROM loans WHERE id = ?").get(info.lastInsertRowid);
    return json(ctx.res, 201, { loan: withProgress(loan, ctx.user.userId) });
  }));

  router.put("/api/loans/:id", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM loans WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "הלוואה לא נמצאה" });
    const v = validateLoanFields(ctx.body, row);
    if (v.error) return json(ctx.res, 400, { error: v.error });
    db.prepare("UPDATE loans SET name = ?, total_installments = ?, monthly_amount = ?, start_date = ?, note = ? WHERE id = ?")
      .run(v.name, v.totalInstallments, v.monthlyAmount, v.startDate, v.note, row.id);
    const updated = db.prepare("SELECT * FROM loans WHERE id = ?").get(row.id);
    return json(ctx.res, 200, { loan: withProgress(updated, ctx.user.userId) });
  }));

  router.delete("/api/loans/:id", requireAuth(async (ctx) => {
    const row = db.prepare("SELECT * FROM loans WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.user.userId);
    if (!row) return json(ctx.res, 404, { error: "הלוואה לא נמצאה" });
    // מנתקים (לא מוחקים) תנועות ששויכו להלוואה הזו - התנועה עצמה (וההיסטוריה הכספית שלה) נשארת,
    // רק הקישור להלוואה שנמחקה מתבטל.
    for (const table of ["transactions", "wedding_transactions", "apartment_transactions"]) {
      db.prepare(`UPDATE ${table} SET loan_id = NULL WHERE loan_id = ?`).run(row.id);
    }
    db.prepare("DELETE FROM loans WHERE id = ?").run(row.id);
    return json(ctx.res, 200, { message: "ההלוואה נמחקה" });
  }));
}

module.exports = { register };
