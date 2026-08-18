// recoveryChannel.js — שליחת קוד שחזור סיסמה: בשיחה קולית (טלפון) או במייל. אף פעם לא ב-SMS.
// במצב MOCK (ברירת מחדל בפיתוח/בדיקות): הקוד לא נשלח באמת, אלא מוחזר בתגובת ה-API כ-demoCode,
// בדיוק כמו שהאב-טיפוס ב-HTML מדגים. כך ניתן לבדוק את כל הזרימה בלי חשבונות Twilio/מייל אמיתיים.
//
// **חשוב**: כל הערוצים עוברים למצב אמיתי **בנפרד ובאופן עצמאי זה מזה** - בכוונה, כדי שאפשר יהיה
// להפעיל ערוצים חינמיים (מייל, ושיחת אימות דרך ימות) בלי לשלם על Twilio בכלל:
//  - channel === "phone": מנסים קודם שיחת אימות **חינמית** דרך ימות המשיח (ר' services/yemotAuth.js -
//    "שיחה שלא עונים לה", 4 הספרות האחרונות של המספר המתקשר הן הקוד) - עובד אוטומטית ברגע ש-
//    YEMOT_API_TOKEN/YEMOT_EXTENSION_NUMBER כבר מוגדרים (אותם משתנים שכבר קיימים בשביל Whisper),
//    בלי צורך בשום דבר נוסף. **אם זה נכשל** (לדוגמה: עדיין לא נבדק מול קו אמיתי, ר' הערה ב-yemotAuth.js) -
//    נופלים אוטומטית חזרה למצב הקודם: RECOVERY_MOCK (בדיקה, הקוד מוצג במסך) או Twilio אמיתי אם מוגדר.
//  - channel === "email": מאציל לגמרי ל-sendEmail (services/email.js), שנשלט ע"י EMAIL_MOCK משלו -
//    ברגע ש-EMAIL_MOCK=false ומוגדרים SENDGRID_API_KEY+EMAIL_FROM, מיילי שחזור/אישור נשלחים אמיתי,
//    גם אם RECOVERY_MOCK עדיין true (כלומר גם אם עדיין לא שולם על Twilio בכלל).
"use strict";

const { placeOutboundCallWithCode } = require("./telephony");
const { sendEmail } = require("./email");
const yemotAuth = require("./yemotAuth");

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

  // ניסיון ראשון: שיחת אימות חינמית דרך ימות (בלי Twilio בכלל) - ר' הערה למעלה. שים לב ש-code
  // (הקוד שהמערכת שלנו יצרה) לא בשימוש בנתיב הזה כלל - ימות קובעים את הקוד בעצמם (4 הספרות
  // האחרונות של המספר המתקשר), ולכן גם האימות בהמשך (VerifyCode) מתבצע מול ימות - ר' routes/auth.js.
  if (yemotAuth.isConfigured()) {
    const sent = await yemotAuth.sendCallerIdCode(phone);
    if (sent) return { ok: true, verifyVia: "yemot" };
    console.log(`[YEMOT-AUTH-DEBUG] SendCode לא הצליח עבור ${phone} - נופלים חזרה למצב הקודם (MOCK/Twilio) כדי לא להשאיר את המשתמש בלי שום קוד`);
  }

  if (MOCK_MODE) {
    console.log(`[MOCK][שיחה קולית] הייתה מתבצעת שיחה אל ${phone} המקריאה את הקוד ${code}`);
    return { ok: true, mock: true, demoCode: code };
  }
  const result = await placeOutboundCallWithCode({ to: phone, code });
  return { ok: result.ok };
}

module.exports = { sendRecoveryCode };
