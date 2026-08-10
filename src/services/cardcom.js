// cardcom.js — מתאם לסליקת "תרומה חודשית" מול Cardcom (הוראת קבע).
// כרטיס אשראי אף פעם לא מגיע לשרת שלנו — Cardcom מפעילים iframe/דף מאובטח משלהם (תואם PCI-DSS),
// ואנחנו רק מקבלים חזרה מזהה הוראת קבע (LowProfileId / token) ומאשרים תשלום.
//
// במצב MOCK (ברירת מחדל): במקום לפנות ל-API האמיתי של Cardcom, יוצרים הוראת קבע מדומה מיידית,
// כדי לאפשר לבדוק את כל זרימת ההרשמה/תרומה בלי חשבון Cardcom אמיתי מוגדר.
//
// במעבר לייצור יש להגדיר משתני סביבה: CARDCOM_TERMINAL_NUMBER, CARDCOM_API_NAME, CARDCOM_API_PASSWORD
// ולהחליף את createRecurringCharge בקריאה אמיתית ל-REST API של Cardcom (ר' תיעוד Cardcom:
// https://docs.cardcom.solutions — יצירת "LowProfile" עם Recurring=true, קבלת קישור לדף תשלום מאובטח,
// ולאחר מכן טיפול ב-Webhook החזרה שלהם לאישור/דחייה של ההוראה).
"use strict";

const MOCK_MODE = process.env.CARDCOM_MOCK !== "false";

async function createRecurringCharge({ userId, planId, amount, fullName, email }) {
  if (MOCK_MODE) {
    console.log(`[MOCK][Cardcom] נוצרה הוראת קבע מדומה: משתמש ${userId}, תוכנית ${planId}, סכום ₪${amount} לחודש`);
    return {
      ok: true,
      mock: true,
      cardcom_recurring_id: `MOCK-${userId}-${Date.now().toString().slice(-6)}`,
      paymentUrl: null, // במצב אמיתי: קישור לדף הסליקה המאובטח של Cardcom להשלמת פרטי כרטיס
    };
  }

  // TODO(ייצור): קריאה אמיתית ל-Cardcom REST API. דוגמת שלד (לא פעיל כרגע):
  //   const res = await fetch("https://secure.cardcom.solutions/api/v11/LowProfile/Create", {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify({
  //       TerminalNumber: process.env.CARDCOM_TERMINAL_NUMBER,
  //       ApiName: process.env.CARDCOM_API_NAME,
  //       ReturnValue: String(userId),
  //       Amount: amount,
  //       ISOCoinId: 1, // ש"ח
  //       Document: { Name: fullName, Email: email },
  //       CreateJWTToken: true, // ליצירת הוראת קבע לחיוב חוזר מדי חודש
  //     }),
  //   });
  //   const data = await res.json();
  //   return { ok: data.ResponseCode === 0, paymentUrl: data.Url, cardcom_recurring_id: data.LowProfileId };
  throw new Error("חיבור אמיתי ל-Cardcom טרם הוגדר (חסרים פרטי טרמינל) — יש לפעול במצב MOCK בינתיים");
}

module.exports = { createRecurringCharge };
