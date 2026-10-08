// speechToText.js — תמלול קולי משודרג לערוץ ימות המשיח: מוריד הקלטה גולמית שנשמרה בימות ומתמלל
// אותה באמצעות Whisper (OpenAI), כתחליף מדויק יותר למנוע זיהוי הדיבור המובנה של ימות - שבבדיקה
// בפועל התברר כלא אמין מספיק במיוחד לשמות אנשים (ר' README, סעיף "זיהוי דיבור משודרג").
//
// תוקן (שינוי ארכיטקטורה, אחרי כמה ניסיונות כושלים עם הקלטה גולמית embedded בתוך שלוחת ה-API עצמה -
// ר' README/CHANGELOG להיסטוריה המלאה): במקום read=...,record,... בתוך שלוחת ה-API (ששם ההקלטה אף
// פעם לא נשמרה בפועל, לפי GetIVR2Dir), עוברים לארכיטקטורה מוכחת-בשטח שמפתחים אחרים משתמשים בה
// בהצלחה: שלוחה **נפרדת** מסוג type=record (מוגדרת ע"י המשתמש בממשק הניהול של ימות - ר' README),
// שהשיחה מועברת אליה זמנית (go_to_folder, ר' services/yemot.js/sayAndGoToRecordExtension), ואחרי
// שההקלטה נשמרת בוודאות שם - חוזרת לשלוחת ה-API שלנו (record_end_goto בהגדרות השלוחה החדשה). כיוון
// ששלוחת ההקלטה קובעת בעצמה את שם הקובץ (לא אנחנו) - מחפשים את ההקלטה **החדשה ביותר** בתיקיית
// השלוחה הזו (ר' findLatestRecording), במקום נתיב/שם קובץ קבוע מראש כמו קודם.
//
// חשוב: זו עדיין תוספת חדשה שלא נבדקה במלואה מול קו ימות אמיתי - חלק מהפרטים המדויקים (למשל פורמט
// ה-mtime שימות מחזירה) התבססו על דוגמאות שנצפו בפועל, אבל ייתכנו עוד הפתעות. לוגים מפורטים
// (`[WHISPER-DEBUG]`) נועדו לעזור לאבחן בדיוק כמו שעשינו עד כה.
//
// במצב MOCK (ברירת מחדל, כל עוד לא הוגדרו כל המפתחות הנדרשים יחד): הפונקציות מחזירות null - מה
// שגורם לקוד הקורא (routes/yemot.js) לחזור אוטומטית לזיהוי הדיבור הרגיל של ימות (freeText STT),
// בלי שום שינוי בהתנהגות עד שכל המפתחות יוגדרו בפועל בייצור.
"use strict";

const YEMOT_API_BASE = "https://www.call2all.co.il/ym/api/";

function isConfigured() {
  return !!(
    process.env.YEMOT_API_TOKEN &&
    process.env.YEMOT_EXTENSION_NUMBER &&
    process.env.YEMOT_RECORD_EXTENSION &&
    process.env.OPENAI_API_KEY
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ימות מחזירה mtime בפורמט "DD/MM/YYYY HH:mm" (נצפה בפועל דרך GetIVR2Dir) - לא ניתן לפרסור ישיר
// עם Date.parse (שמניח פורמט אמריקאי MM/DD/YYYY). ממירים ידנית ל-ISO כדי שאפשר יהיה למיין לפי זמן
// אמיתי. מחזיר null אם הפורמט לא כמצופה (כדי שנופלים בחזרה למיון לפי שם, ר' findLatestRecording).
function parseYemotMtime(mtimeStr) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(String(mtimeStr || ""));
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${min}:00`;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : ts;
}

// מוצא את ההקלטה החדשה ביותר בתיקיית שלוחת ההקלטה הנפרדת (YEMOT_RECORD_EXTENSION) - כי בארכיטקטורה
// הזו ימות עצמה קובעת את שם הקובץ (לא אנחנו, בניגוד לניסיון הקודם עם path/file_name בתוך read=).
// מחזיר את שם הקובץ (למשל "0000.wav") או null אם לא נמצא/שגיאה.
async function findLatestRecording() {
  if (!isConfigured()) return null;
  try {
    const token = process.env.YEMOT_API_TOKEN;
    const recordExt = process.env.YEMOT_RECORD_EXTENSION;
    const url = `${YEMOT_API_BASE}GetIVR2Dir?token=${encodeURIComponent(token)}&path=${encodeURIComponent(recordExt)}`;
    const res = await fetch(url);
    const rawText = await res.text();
    console.log(`[WHISPER-DEBUG] רשימת קבצים בשלוחת ההקלטה (${recordExt}): ${rawText.slice(0, 500)}`);
    let data;
    try { data = JSON.parse(rawText); } catch { data = null; }
    if (!data || !Array.isArray(data.files) || !data.files.length) {
      console.log(`[WHISPER-DEBUG] שלוחת ההקלטה ריקה או שגיאה בקריאת הרשימה (status ${res.status})`);
      return null;
    }
    const audioFiles = data.files.filter((f) => /\.(wav|mp3)$/i.test(f.name || ""));
    if (!audioFiles.length) return null;
    audioFiles.sort((a, b) => {
      const ta = parseYemotMtime(a.mtime);
      const tb = parseYemotMtime(b.mtime);
      if (ta !== null && tb !== null) return tb - ta; // חדש קודם, לפי זמן אמיתי
      return String(b.name).localeCompare(String(a.name)); // גיבוי: לפי שם, אם אין mtime תקין
    });
    return audioFiles[0].name;
  } catch (e) {
    console.log(`[WHISPER-DEBUG] שגיאה בחיפוש ההקלטה האחרונה: ${e.message}`);
    return null;
  }
}

// מוריד קובץ הקלטה ששמור בימות. מחזיר null (ולא זורק שגיאה) בכל מקרה של כישלון - כדי שהקוד הקורא
// תמיד יוכל ליפול בחזרה בבטחה (ר' routes/yemot.js - כשזה קורה, מתייחסים לזה כאילו לא נשמע דיבור).
//
// ניסיון חוזר על 404: יתכן שיש עיכוב קצר בין סיום/אישור ההקלטה לזמינותה להורדה. ניסיון חוזר יחיד
// אחרי המתנה קצרה (1.5 שניות) פותר את רוב המקרים האלה, בלי לעכב את השיחה יותר מדי אם זו כן תקלה אמיתית.
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
    // שגיאה כטקסט/JSON מימות, גם עם סטטוס 200) - עדיף להיכשל בבטחה מאשר לשלוח זבל ל-Whisper.
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

// בודק שיש לפחות אות עברית אחת בטקסט (טווח יוניקוד של עברית: א-ת, כולל ניקוד/גרשיים).
function containsHebrew(str) {
  return /[֐-׿]/.test(String(str || ""));
}

// תוקן (באג אמיתי שהתגלה בבדיקה חיה בפועל - ר' README): המודל gpt-4o-mini-transcribe, למרות
// שהתבקש בפירוש language="he", "הזה" (hallucinate) לפעמים את התמלול בכתב **לא-עברי** לגמרי -
// בדיקות חוזרות מול קו אמיתי הראו את אותה מילה בעברית ("חונכות") מתומללת בכל פעם בכתב אחר לגמרי:
// פעם אחת כאותיות לטיניות ("Conchód"), פעם כקיריליות ("Холхот"), פעם כערבית ("خونخود") - אף פעם
// לא בעברית עצמה! גם שם (Shalom Steinberg) תומלל נכון מבחינת התוכן אבל בכתב לטיני במקום עברי.
// המעבר למודל whisper-1 (הישן והבוגר יותר, בניגוד לגרסאות ה"4o" החדשות) נועד לשפר את זה - הוא
// מודל שנבדק במשך שנים על תמלול רב-לשוני ונחשב אמין יותר עבור שפות שאינן אנגלית. בנוסף, כרשת
// ביטחון (ר' containsHebrew למעלה) - אם בכל זאת מתקבל תמלול בלי אף אות עברית אחת, מתייחסים לזה
// כאל כישלון (מחזירים null) במקום לנסות להשתמש בטקסט חסר-משמעות הזה - כדי שהמערכת תבקש מהמתקשר
// לנסות שוב, במקום "להיתקע" בלולאה שמנסה להתאים קטגוריה/שם לטקסט שלעולם לא יתאים.
// ליבת התמלול - בלי תלות בימות (אפשר להפעיל אותה גם על הקלטות של ערוץ אחר, כמו טכנוליין - ר'
// routes/technoline.js). מנוע: אם מוגדר STT_SERVICE_URL - שירות תמלול חיצוני/עצמאי (חוזה פשוט:
// POST multipart עם שדה "file" (ו"prompt" אופציונלי) -> JSON {"text": "..."} - מיועד לשירות
// ivrit.ai משותף לכל הפרויקטים, ר' זיכרון הפרויקט); אחרת OpenAI Whisper אם יש OPENAI_API_KEY.
function sttEngineAvailable() {
  return Boolean(process.env.STT_SERVICE_URL || process.env.OPENAI_API_KEY);
}

async function transcribeBuffer(audioBuffer, vocabularyHint, { contentType = "audio/wav", filename = "recording.wav" } = {}) {
  if (!audioBuffer || !sttEngineAvailable()) return null;
  try {
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: contentType }), filename);
    if (vocabularyHint) form.append("prompt", vocabularyHint);
    let url, headers = {};
    if (process.env.STT_SERVICE_URL) {
      url = process.env.STT_SERVICE_URL;
      if (process.env.STT_SERVICE_TOKEN) headers.Authorization = `Bearer ${process.env.STT_SERVICE_TOKEN}`;
    } else {
      url = "https://api.openai.com/v1/audio/transcriptions";
      headers.Authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
      form.append("model", "whisper-1");
      form.append("language", "he"); // מבקשים במפורש עברית - עוזר לדיוק, גם אם המודל יודע לזהות שפה לבד
    }
    const res = await fetch(url, { method: "POST", headers, body: form });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.log(`[WHISPER-DEBUG] קריאה לתמלול נכשלה: סטטוס ${res.status} - ${errText.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    const transcribed = String(data.text || "").trim();
    console.log(`[WHISPER-DEBUG] תמלול: "${transcribed}"`);
    if (transcribed && !containsHebrew(transcribed)) {
      console.log(`[WHISPER-DEBUG] התמלול לא מכיל אף אות עברית ("${transcribed}") - כנראה "הזיה" של המודל (שפה/כתב שגויים), מתייחסים לזה כאילו נכשל`);
      return null;
    }
    return transcribed || null;
  } catch (e) {
    console.log(`[WHISPER-DEBUG] שגיאה בתמלול: ${e.message}`);
    return null;
  }
}

// עטיפה לערוץ ימות (דורשת את כל ההגדרות של ימות כמו תמיד - ר' isConfigured) - ההתנהגות הקיימת לא משתנה.
async function transcribeAudio(audioBuffer, vocabularyHint) {
  if (!isConfigured()) return null;
  return transcribeBuffer(audioBuffer, vocabularyHint);
}

// פונקציית נוחות משולבת: מוצאת את ההקלטה האחרונה בשלוחת ההקלטה, מורידה ומתמללת אותה בפעולה אחת.
// מחזירה null בכל כישלון בדרך (ואז הקוד הקורא נופל בחזרה לזיהוי הדיבור הרגיל של ימות).
// vocabularyHint אופציונלי - ר' הערה ב-transcribeAudio - מועבר משם השלב הנוכחי בשיחה (routes/yemot.js).
async function downloadAndTranscribe(vocabularyHint) {
  if (!isConfigured()) return null;
  const fileName = await findLatestRecording();
  if (!fileName) return null;
  const recordExt = process.env.YEMOT_RECORD_EXTENSION;
  const downloadPath = `ivr2:${recordExt}/${fileName}`;
  const audio = await downloadYemotRecording(downloadPath);
  if (!audio) return null;
  return transcribeAudio(audio, vocabularyHint);
}

module.exports = { sttEngineAvailable, transcribeBuffer, isConfigured, findLatestRecording, downloadYemotRecording, transcribeAudio, downloadAndTranscribe, containsHebrew };
