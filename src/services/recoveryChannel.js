// recoveryChannel.js — שליחת קוד שחזור סיסמה: בשיחה קולית (טלפון) או במייל. אף פעם לא ב-SMS.
// במצב MOCK (ברירת מחדל בפיתוח/בדיקות): הקוד לא נשלח באמת, אלא מוחזר בתגובת ה-API כ-demoCode,
// בדיוק כמו שהאב-טיפוס ב-HTML מדגים. כך ניתן לבדוק את כל הזרימה בלי חשבונות Twilio/מייל אמיתיים.
//
// **חשוב**: כל הערוצים עוברים למצב אמיתי **בנפרד ובאופן עצמאי זה מזה**:
//  - channel === "email": מאציל לגמרי ל-sendEmail (services/email.js), שנשלט ע"י EMAIL_MOCK משלו -
//    ברגע ש-EMAIL_MOCK=false ומוגדרים SENDGRID_API_KEY+EMAIL_FROM, מיילי שחזור/אישור נשלחים אמיתי,
//    גם אם RECOVERY_MOCK עדיין true (כלומר גם אם עדיין לא שולם על Twilio בכלל). זו האפשרות החינמית.
//  - channel === "phone": MOCK (הקוד מוצג במסך) או שיחה אמיתית דרך Twilio (בתשלום) אם RECOVERY_MOCK=false.
//    **הערה**: בעבר נוסה כאן ניסיון לשיחת-אימות חינמית דרך ה-API של ימות המשיח (services/yemotAuth.js,
//    "DoubleAuth") - נבדק מול קו אמיתי ונכשל: מתברר שה-API הזה מיועד לאבטחת ההתחברות של בעל החשבון
//    ל-API של ימות עצמו, ולא לשליחת שיחת-אימות לכל מספר טלפון שנבחר. אין כרגע דרך חינמית לאמת טלפון -
//    ר' הערה מפורטת בראש yemotAuth.js. הקוד נשאר שם לתיעוד אך אינו נקרא יותר מכאן.
"use strict";

const { placeOutboundCallWithCode } = require("./telephony");
const { sendEmail } = require("./email");

const MOCK_MODE = process.env.RECOVERY_MOCK !== "false"; // ברירת מחדל: מצב בדיקה פעיל (רלוונטי רק כשגם ימות וגם Twilio לא זמינים, ר' למעלה)

async function sendRecoveryCode({ channel, phone, email, code }) {
  const useChannel = channel === "email" ? "email" : "phone";

  if (useChannel === "email") {
    if (!email) return { ok: false, error: "לא קיימת כתובת מייל רשומה למשתמש זה" };
    // EMAIL_MOCK (לא RECOVERY_MOCK!) קובע אם השליחה כאן אמיתית - ר' הערה למעלה.
    const emailIsMock = process.env.EMAIL_MOCK !== "false";
    if (emailIsMock) {
      console.log(`[MOCK][מייל] היה נשלח קוד שחזור ${code} אל ${email}`);
      return { ok: true, mock: true, demoCode: code };
    }
    await sendEmail({
      to: email,
      subject: "קוד אימות - הפנקס שלי",
      body: `קוד האימות שלכם הוא: ${code}\n\nהקוד בתוקף ל-10 דקות. אם לא ביקשתם קוד זה, אפשר להתעלם מההודעה.`,
    });
    return { ok: true };
  }

  // channel === "phone"
  if (!phone) return { ok: false, error: "לא קיים מספר טלפון רשום למשתמש זה" };

  if (MOCK_MODE) {
    console.log(`[MOCK][שיחה קולית] הייתה מתבצעת שיחה אל ${phone} המקריאה את הקוד ${code}`);
    return { ok: true, mock: true, demoCode: code };
  }
  const result = await placeOutboundCallWithCode({ to: phone, code });
  return { ok: result.ok };
}

module.exports = { sendRecoveryCode };
