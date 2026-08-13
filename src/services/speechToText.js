// speechToText.js — תמלול קולי משודרג לערוץ ימות המשיח: מוריד הקלטה גולמית שנשמרה בימות (מצב
// "record" של הפרוטוקול, ר' sayAndRecord ב-services/yemot.js) ומתמלל אותה באמצעות Whisper (OpenAI),
// כתחליף מדויק יותר למנוע זיהוי הדיבור המובנה של ימות - שבבדיקה בפועל התברר כלא אמין מספיק במיוחד
// לשמות אנשים (ר' README, סעיף "זיהוי דיבור משודרג").
//
// חשוב: זו תוספת חדשה שלא נבדקה עדיין מול קו ימות אמיתי (אין לנו דרך לבדוק שיחות טלפון אמיתיות
// מהסביבה שבה הקוד נכתב) - היא בנויה בזהירות רבה לגמרי (MOCK כברירת מחדל, נכשלת בשקט לזיהוי הדיבור
// הרגיל של ימות אם משהו משתבש) אבל חייבת להיבדק בפועל אחרי הפריסה. לוגים מפורטים (`[WHISPER-DEBUG]`)
// נועדו לעזור לאבחן בדיוק כמו שעשינו עם `[YEMOT-DEBUG]`.
//
// במצב MOCK (ברירת מחדל, כל עוד לא הוגדרו YEMOT_API_TOKEN, YEMOT_EXTENSION_NUMBER, ו-OPENAI_API_KEY
// יחד): הפונקציות מחזירות null - מה שגורם לקוד הקורא (routes/yemot.js) לחזור אוטומטית לזיהוי הדיבור
// הרגיל של ימות (freeText STT), בלי שום שינוי בהתנהגות עד שכל המפתחות יוגדרו בפועל בייצור.
"use strict";

const YEMOT_API_BASE = "https://www.call2all.co.il/ym/api/";

function isConfigured() {
  return !!(process.env.YEMOT_API_TOKEN && process.env.YEMOT_EXTENSION_NUMBER && process.env.OPENAI_API_KEY);
}

// בונה את הנתיב (path) שבו ההקלטה נשמרת/מחופשת בימות - קבוע ונגזר מ-callId, כדי שנוכל לדעת בדיוק
// איפה לחפש אותה בהמשך בלי להסתמך על מה שימות מחזירה בתגובה (שהפורמט המדויק שלה לא מתועד במלואו).
function recordingPath(callId) {
  const ext = process.env.YEMOT_EXTENSION_NUMBER;
  const safeFileName = `hp-${String(callId || "").replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return { path: ext, fileName: safeFileName, downloadPath: `ivr2:${ext}/${safeFileName}.wav` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// מוריד קובץ הקלטה ששמור בימות. מחזיר null (ולא זורק שגיאה) בכל מקרה של כישלון - כדי שהקוד הקורא
// תמיד יוכל ליפול בחזרה בבטחה (ר' routes/yemot.js - כשזה קורה, מתייחסים לזה כאילו לא נשמע דיבור,
// לא נופלים בחזרה לזיהוי הדיבור הרגיל של ימות ולא לערך גולמי לא רלוונטי).
//
// ניסיון חוזר על 404: בבדיקה בפועל מול קו אמיתי התברר שהורדת ההקלטה מיד אחרי שהיא נגמרה (כלומר
// באותה בקשה שבה ימות מדווחת שההקלטה הסתיימה) נכשלת לפעמים ב-404 - כנראה כי הקובץ עוד לא נשמר
// בפועל אצל ימות באותו הרגע (עיכוב קצר בין סיום ההקלטה לזמינותה להורדה). ניסיון חוזר יחיד אחרי
// המתנה קצרה (1.5 שניות) פותר את רוב המקרים האלה, בלי לעכב את השיחה יותר מדי אם זו כן תקלה אמיתית.
async function downloadYemotRecording(downloadPath, attempt = 1) {
  if (!isConfigured()) return null;
  try {
    const token = process.env.YEMOT_API_TOKEN;
    const url = `${YEMOT_API_BASE}DownloadFile?token=${encodeURIComponent(token)}&path=${encodeURIComponent(downloadPath)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[WHISPER-DEBUG] הורדת הקלטה מימות נכשלה: סטטוס ${res.status}, נתיב ${downloadPath}, ניסיון ${attempt}`);
      if (res.status === 404 && attempt < 2) {
        await sleep(1500);
        return downloadYemotRecording(downloadPath, attempt + 1);
      }
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // בדיקת שפיות בסיסית: קובץ WAV אמיתי תמיד מתחיל בבתים "RIFF". אם קיבלנו משהו אחר (למשל הודעת
    // שגיאה כטקסט/JSON מימות, גם עם סטטוס 200 - למשל אם ההקלטה עדיין לא מוכנה) - עדיף להיכשל בבטחה
    // מאשר לשלוח זבל ל-Whisper.
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
      console.log(`[WHISPER-DEBUG] הקובץ שהתקבל מימות לא נראה כמו WAV תקין (אורך ${buf.length} בתים), נתיב ${downloadPath}, ניסיון ${attempt}`);
      if (attempt < 2) {
        await sleep(1500);
        return downloadYemotRecording(downloadPath, attempt + 1);
      }
      return null;
    }
    console.log(`[WHISPER-DEBUG] הקלטה הורדה בהצלחה מימות (${buf.length} בתים), נתיב ${downloadPath}, ניסיון ${attempt}`);
    return buf;
  } catch (e) {
    console.log(`[WHISPER-DEBUG] שגיאה בהורדת הקלטה מימות: ${e.message}, ניסיון ${attempt}`);
    return null;
  }
}

// שולח קובץ שמע לתמלול אצל OpenAI ומחזיר את הטקסט המתומלל בעברית, או null אם נכשל/לא מוגדר.
// המודל: gpt-4o-mini-transcribe (לא whisper-1 הישן) - זול יותר (כ-0.003$ לדקה, לעומת מודלים אחרים
// אצל OpenAI) ומופיע כמודל התמלול הנוכחי בתיעוד המחירים הרשמי של OpenAI (whisper-1 כבר לא מופיע שם
// באופן מפורש נכון לעכשיו) - ר' README, סעיף "זיהוי דיבור משודרג" להסבר עלויות מלא.
async function transcribeAudio(audioBuffer) {
  if (!isConfigured() || !audioBuffer) return null;
  try {
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "recording.wav");
    form.append("model", "gpt-4o-mini-transcribe");
    form.append("language", "he"); // מבקשים במפורש עברית - עוזר לדיוק, גם אם המודל יודע לזהות שפה לבד
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.log(`[WHISPER-DEBUG] קריאה ל-Whisper נכשלה: סטטוס ${res.status} - ${errText.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    const transcribed = String(data.text || "").trim();
    console.log(`[WHISPER-DEBUG] תמלול Whisper: "${transcribed}"`);
    return transcribed || null;
  } catch (e) {
    console.log(`[WHISPER-DEBUG] שגיאה בתמלול Whisper: ${e.message}`);
    return null;
  }
}

// פונקציית נוחות משולבת: מורידה ומתמללת בפעולה אחת. מחזירה null בכל כישלון בדרך (ואז הקוד הקורא
// נופל בחזרה לזיהוי הדיבור הרגיל של ימות במקום לתקוע את השיחה).
async function downloadAndTranscribe(callId) {
  if (!isConfigured()) return null;
  const { downloadPath } = recordingPath(callId);
  const audio = await downloadYemotRecording(downloadPath);
  if (!audio) return null;
  return transcribeAudio(audio);
}

module.exports = { isConfigured, recordingPath, downloadYemotRecording, transcribeAudio, downloadAndTranscribe };
