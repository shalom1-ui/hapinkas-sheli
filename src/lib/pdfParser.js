// pdfParser.js — קורא דפי חיוב/עו"ש בפורמט PDF ומחזיר מטריצת שורות (בדיוק כמו xlsxParser/csvParser/
// htmlTableParser), בלי שום ספרייה חיצונית - עקרון הפרויקט. נבנה ונבדק מול קובץ אמיתי (דף פירוט
// דיגיטלי של כאל - חברת אשראי ישראלית), ר' README, "ייבוא תנועות מאקסל/CSV/PDF".
//
// PDF הוא פורמט הרבה יותר מורכב מ-ZIP/XML/HTML: אין בו מושג מובנה של "טבלה" בכלל - יש רק טקסט
// ממוקם בקואורדינטות (x,y) על העמוד, וצריך לשחזר מבנה טבלה מהמיקומים בעצמנו. שלבי העבודה:
//   1) מפרקים את מבנה האובייקטים של ה-PDF (סריקת "N 0 obj ... endobj" ישירות בקובץ - טכניקת
//      "שחזור גס" עמידה יותר מפענוח טבלת ה-xref הפורמלית, ועובדת גם אם ה-xref פגום מעט).
//   2) מוצאים את גופן העמוד (Type0/CID עם מפת ToUnicode) ומפענחים את מפת ToUnicode לטבלת
//      code->יוניקוד (בדיוק כמו xlsxParser מפענח sharedStrings, רק בפורמט CMap שונה).
//   3) מפרקים את זרם התוכן (content stream, לרוב דחוס FlateDecode - zlib.inflateSync) לרצף
//      אופרטורים, ועוקבים אחרי Td/TD/Tm (מיקום) ו-Tj/TJ (הצגת טקסט) כדי לקבל רשימת "ריצות טקסט"
//      עם קואורדינטת (x,y) לכל אחת.
//   4) מקבצים ריצות לפי שורה (y דומה) ולפי עמודה (x בטווח עמודת הכותרת המתאימה - נגזר משורת
//      הכותרות שזוהתה, בדיוק כמו importMapping.js מזהה עמודות לפי כותרות בעברית/אנגלית).
//   5) **תיקון כיווניות (bidi)**: גילינו בבדיקה מול קובץ אמיתי שה-PDF מצייר כל תו בעברית *ובמספרים*
//      כריצת-Tj נפרדת, ממוקמים מימין לשמאל לפי סדר התצוגה החזותי - כלומר תאריך כמו "19/07/2026"
//      מגיע כ-10 ריצות בודדות ("6","2","0","2","/","7","0","/","9","1"), וצריך להפוך את סדר
//      ה*ריצות* (לא את התווים בתוך ריצה - ריצות עם כמה תווים, כמו סכום "₪ 13.30" שכבר מגיע
//      כריצה אחת שלמה, כבר נכונות כמו שהן) בתוך כל "מקטע" רציף שאינו עברית (ספרות/אנגלית/סימנים) -
//      זה בדיוק ההפך מהטקסט העברי הסובב אותו, שכבר נכון בסדר ההופעה הרגיל (ר' reorderRowRuns למטה).
"use strict";
const zlib = require("zlib");

// ---------- שכבה 1: איתור אובייקטים וזרמים (בלי לפענח xref פורמלי - סריקה ישירה, עמידה יותר) ----------
function findObjectStart(pdfText, objNum) {
  const re = new RegExp(`(^|[^0-9])${objNum}\\s+\\d+\\s+obj`, "g");
  const m = re.exec(pdfText);
  return m ? m.index + m[0].length : -1;
}

function getObjectRaw(pdfText, objNum) {
  const start = findObjectStart(pdfText, objNum);
  if (start < 0) return null;
  const endobjIdx = pdfText.indexOf("endobj", start);
  return { start, raw: pdfText.slice(start, endobjIdx < 0 ? undefined : endobjIdx) };
}

// מחזיר את הבתים הגולמיים (אחרי פענוח FlateDecode אם צריך) של ה-stream ששייך לאובייקט הנתון.
function getStreamBytes(buffer, pdfText, objNum) {
  const o = getObjectRaw(pdfText, objNum);
  if (!o) return null;
  const streamKwIdx = o.raw.indexOf("stream");
  if (streamKwIdx < 0) return null;
  let dataStart = o.start + streamKwIdx + "stream".length;
  if (pdfText[dataStart] === "\r") dataStart++;
  if (pdfText[dataStart] === "\n") dataStart++;
  const endstreamIdx = pdfText.indexOf("endstream", dataStart);
  if (endstreamIdx < 0) return null;
  const rawBytes = buffer.subarray(dataStart, endstreamIdx);
  const dictPart = o.raw.slice(0, streamKwIdx);
  const isFlate = /\/Filter\s*\/FlateDecode/.test(dictPart) || /\/Filter\s*\[[^\]]*\/FlateDecode/.test(dictPart);
  if (!isFlate) return rawBytes; // תוכן לא-דחוס (נדיר לזרמי טקסט, אבל תומכים ליתר ביטחון)
  try {
    return zlib.inflateSync(rawBytes);
  } catch (e) {
    return null; // זרם פגום/לא בפורמט הצפוי - מתעלמים ממנו בשקט, לא קורסים על כל הקובץ
  }
}

function findAllObjectNumbers(pdfText) {
  return [...new Set([...pdfText.matchAll(/(?:^|[^0-9])(\d+)\s+\d+\s+obj/g)].map(m => m[1]))];
}

// ---------- שכבה 2: מפת ToUnicode (CMap) - ממירה קוד-תו (CID, ר' Identity-H) ליוניקוד אמיתי ----------
function parseToUnicodeCMap(cmapText) {
  const map = new Map();
  for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(src, 16), hexToUnicode(dst));
    }
  }
  for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    const consumedRanges = [];
    for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(m[1], 16);
      const dsts = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map(x => x[1]);
      dsts.forEach((d, i) => map.set(lo + i, hexToUnicode(d)));
      consumedRanges.push([m.index, m.index + m[0].length]);
    }
    for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      if (consumedRanges.some(([s, e]) => m.index >= s && m.index < e)) continue;
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), dstLo = parseInt(m[3], 16);
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCodePoint(dstLo + (c - lo)));
    }
  }
  return map;
}
function hexToUnicode(hex) {
  let out = "";
  for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

// מוצא את אובייקט הגופן הראשון עם ToUnicode תקין, מתוך כל האובייקטים בקובץ (לא תלוי במבנה עמודים
// מדויק - מספיק כדי לפענח את רוב הטקסט בדפי חיוב טיפוסיים, ששם יש בדרך כלל גופן משותף אחד לכל העמוד).
function findFontCMap(buffer, pdfText) {
  for (const n of findAllObjectNumbers(pdfText)) {
    const o = getObjectRaw(pdfText, n);
    if (!o) continue;
    const dictOnly = o.raw.split("stream")[0];
    if (/\/Type\s*\/Font\b/.test(dictOnly) && /\/ToUnicode\s+(\d+)\s+0\s+R/.test(dictOnly)) {
      const m = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(dictOnly);
      const cmapBytes = getStreamBytes(buffer, pdfText, m[1]);
      if (cmapBytes) return parseToUnicodeCMap(cmapBytes.toString("latin1"));
    }
  }
  return null;
}

// ---------- שכבה 3: פענוח מחרוזות PDF (literal + hex) לרצף קודי-תו, ואז ליוניקוד דרך ה-CMap ----------
// unescape תקין למחרוזת literal בפרוטוקול PDF - חובה *לפני* פירוק לזוגות בתים (Identity-H, 2 בתים
// לכל קוד-תו), אחרת מחרוזת עם \( \) \\ וכו' מקלקלת את היישור.
function unescapePdfLiteral(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") { out.push(ch.charCodeAt(0) & 0xff); continue; }
    const next = raw[i + 1];
    if (next === "n") { out.push(10); i++; }
    else if (next === "r") { out.push(13); i++; }
    else if (next === "t") { out.push(9); i++; }
    else if (next === "b") { out.push(8); i++; }
    else if (next === "f") { out.push(12); i++; }
    else if (next === "(" || next === ")" || next === "\\") { out.push(next.charCodeAt(0)); i++; }
    else if (next === "\n") { i++; }
    else if (next === "\r") { i++; if (raw[i + 1] === "\n") i++; }
    else if (next >= "0" && next <= "7") {
      let oct = next; i++;
      for (let k = 0; k < 2 && raw[i + 1] >= "0" && raw[i + 1] <= "7"; k++) { oct += raw[i + 1]; i++; }
      out.push(parseInt(oct, 8) & 0xff);
    } else if (next !== undefined) { out.push(next.charCodeAt(0) & 0xff); i++; }
  }
  return out;
}
function codesFromBytes(byteArr) {
  const codes = [];
  for (let i = 0; i < byteArr.length; i += 2) codes.push(((byteArr[i] || 0) << 8) | (byteArr[i + 1] || 0));
  return codes;
}
function decodeShowTextOperand(token, cmap) {
  if (token.startsWith("(")) {
    return codesFromBytes(unescapePdfLiteral(token.slice(1, -1))).map(c => cmap.get(c) ?? "").join("");
  }
  if (token.startsWith("<")) {
    const clean = token.slice(1, -1).replace(/\s/g, "");
    const codes = [];
    for (let i = 0; i < clean.length; i += 4) codes.push(parseInt(clean.slice(i, i + 4), 16));
    return codes.map(c => cmap.get(c) ?? "").join("");
  }
  return "";
}

// ---------- שכבה 4: הרצת אופרטורי זרם התוכן - שולפים ריצות טקסט עם מיקום (x,y) ----------
const TEXT_TOKEN_RE = /\((?:[^()\\]|\\.)*\)|\[(?:[^\[\]]|\[[^\]]*\])*\]|<[0-9a-fA-F\s]*>|[-\d.]+|\/[A-Za-z0-9.]+|[A-Za-z]+/g;

function extractTextRuns(contentText, cmap) {
  const runs = [];
  let x = 0, y = 0;
  const tokens = contentText.match(TEXT_TOKEN_RE) || [];
  let stack = [];
  for (const tok of tokens) {
    if (/^[A-Za-z]+$/.test(tok) && tok !== "true" && tok !== "false") {
      if (tok === "Td" || tok === "TD") {
        x += parseFloat(stack[stack.length - 2]) || 0;
        y += parseFloat(stack[stack.length - 1]) || 0;
      } else if (tok === "Tm") {
        x = parseFloat(stack[stack.length - 2]) || 0;
        y = parseFloat(stack[stack.length - 1]) || 0;
      } else if (tok === "Tj") {
        const s = stack[stack.length - 1];
        if (s) {
          const txt = decodeShowTextOperand(s, cmap);
          if (txt) runs.push({ x, y, text: txt });
        }
      } else if (tok === "TJ") {
        const arr = stack[stack.length - 1];
        if (arr && arr.startsWith("[")) {
          const parts = arr.slice(1, -1).match(/\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]*>/g) || [];
          const combined = parts.map(p => decodeShowTextOperand(p, cmap)).join("");
          if (combined) runs.push({ x, y, text: combined });
        }
      } else if (tok === "BT") {
        x = 0; y = 0;
      }
      stack = [];
    } else {
      stack.push(tok);
    }
  }
  return runs;
}

// ---------- שכבה 5: שחזור סדר קריאה נכון (bidi פשוט) בתוך כל תא/עמודה ----------
// ר' הערת הפתיחה: הופכים רק "מקטעים" רציפים שאינם עברית (ספרות/אנגלית/סימנים) - טקסט עברי כבר
// מגיע בסדר קריאה נכון (ריצה-אחר-ריצה, ימין-שמאל), אבל מקטע לא-עברי בתוך אותה שורה מיוצג ע"י ימות
// כמה ריצות-תו בודדות שמסודרות "הפוך" (כאילו גם הן נכתבו ימין-לשמאל) - צריך להחזיר אותן לסדר הרגיל.
function reorderRunsForReading(runsSortedByXDesc) {
  const isHebrew = t => /[֐-׿]/.test(t);
  const result = [];
  let i = 0;
  while (i < runsSortedByXDesc.length) {
    if (!isHebrew(runsSortedByXDesc[i].text)) {
      let j = i;
      while (j < runsSortedByXDesc.length && !isHebrew(runsSortedByXDesc[j].text)) j++;
      result.push(...runsSortedByXDesc.slice(i, j).reverse());
      i = j;
    } else {
      result.push(runsSortedByXDesc[i]);
      i++;
    }
  }
  return result.map(r => r.text).join("");
}

// ---------- שכבה 6: קיבוץ לשורות (y) ולעמודות (x) לפי גבולות שנגזרו משורת הכותרות ----------
const ROW_Y_TOLERANCE = 2; // שתי ריצות עם הפרש y קטן מזה נחשבות לאותה שורה (בדף אמיתי - כ-1.5)

function groupIntoRows(runs) {
  const sorted = [...runs].sort((a, b) => b.y - a.y); // מלמעלה למטה
  const rows = [];
  for (const r of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - r.y) <= ROW_Y_TOLERANCE) {
      last.runs.push(r);
    } else {
      rows.push({ y: r.y, runs: [r] });
    }
  }
  return rows;
}

// מזהה שורת כותרות לפי מילות מפתח (בדיוק כמו importMapping.findHeaderRowIndex, אבל כאן על בסיס
// ריצות טקסט + מיקום x - כדי לגזור מכך את גבולות העמודות בפועל, לא רק את מספר השורה).
const HEADER_HINTS = ["תאריך", "שם בית", "עסק", "ענף", "פירוט", "סכום", "תיאור", "date", "amount"];
// מחזיר את *האינדקס* של שורת הכותרות בתוך rows (לא רק את השורה עצמה) - כדי שהקורא יוכל גם לבדוק
// את השורה שמיד אחריה (ר' הערה ב-buildColumnBoundaries על כותרת דו-שורתית).
function findHeaderRowIndex(rows) {
  const limit = Math.min(rows.length, 40);
  for (let i = 0; i < limit; i++) {
    const rowText = reorderRunsForReading([...rows[i].runs].sort((a, b) => b.x - a.x));
    const hits = HEADER_HINTS.filter(h => rowText.includes(h)).length;
    if (hits >= 3) return i;
  }
  return -1;
}

// בונה גבולות עמודות מתוך ריצות שורת הכותרות: מקבצים ריצות סמוכות ב-x (פער קטן, אותה "מילה"/תווית)
// לכדי אשכולות, וכל אשכול הופך לעמודה.
// תוקן (נבדק מול קובץ אמיתי - כאל): כותרות "סכום עסקה"/"סכום חיוב" (שתי עמודות סכום שונות מאוד
// בחשיבותן - סכום העסקה המקורי מול הסכום שבפועל מחויב החודש) מודפסות ב-PDF כשתי *שורות* נפרדות -
// "סכום"/"סכום" בשורה אחת, ו"עסקה"/"חיוב" בשורה שממש מתחתיה. בלי המיזוג הזה שתי העמודות היו
// מקבלות תווית זהה ("סכום") ואי אפשר להעדיף "חיוב" (ר' importMapping.js preferAmountKeyword).
// continuationRow אופציונלי - אם קיים, ממוזג טקסטו לתוך תווית העמודה שמכילה x קרוב.
const CLUSTER_X_GAP = 8;
function buildColumnBoundaries(headerRow, continuationRow) {
  const sorted = [...headerRow.runs].sort((a, b) => b.x - a.x); // ימין לשמאל
  const clusters = [];
  for (const r of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && last.minX - r.x <= CLUSTER_X_GAP) {
      last.runs.push(r);
      last.minX = Math.min(last.minX, r.x);
      last.maxX = Math.max(last.maxX, r.x);
    } else {
      clusters.push({ runs: [r], minX: r.x, maxX: r.x });
    }
  }
  // תוקן: ריצות ההמשך (continuationRow) הן שורה *נפרדת פיזית* (y אחר) - לא ניתן לערבב אותן עם
  // ריצות הכותרת הראשית ולמיין הכל יחד לפי x בלבד (זה "קורע" מילים משתי השורות זו לתוך זו, למשל
  // "תאריך"+"העסקה" הופכות ל"התעאסריקך" חסר-משמעות). במקום זה משחזרים כל שורה *בנפרד* לכל אשכול,
  // ואז מצרפים את שתי המחרוזות עם רווח - "תאריך" + "" = "תאריך", "סכום" + "חיוב" = "סכום חיוב".
  if (continuationRow) {
    for (const c of clusters) c.continuationRuns = [];
    for (const r of continuationRow.runs) {
      let best = null, bestDist = Infinity;
      for (const c of clusters) {
        const center = (c.minX + c.maxX) / 2;
        const dist = Math.abs(r.x - center);
        if (dist < bestDist) { bestDist = dist; best = c; }
      }
      if (best) best.continuationRuns.push(r);
    }
  }
  // תוקן (נבדק מול קובץ אמיתי): גבולות "אמצע המרחק בין כותרות שכנות" נכשלו בפועל - שדה תאריך
  // ("תאריך", 5 תווים) צר בהרבה מהנתון בפועל ("19/11/2025", 10 תווים), כך שהתו הראשון של התאריך
  // (הרחוק ביותר מהכותרת) "דלף" לעמודת השם הסמוכה. **החלפה**: משייכים כל ריצה לעמודה שמרכזה
  // (centerX) הכי קרוב אליה - הרבה יותר סובלני לנתונים שרחבים/צרים מכותרת העמודה שלהם.
  return clusters.map((c) => {
    const mainLabel = reorderRunsForReading([...c.runs].sort((a, b) => b.x - a.x));
    const contLabel = c.continuationRuns && c.continuationRuns.length
      ? reorderRunsForReading([...c.continuationRuns].sort((a, b) => b.x - a.x))
      : "";
    return {
      label: contLabel ? `${mainLabel} ${contLabel}`.trim() : mainLabel,
      centerX: (c.minX + c.maxX) / 2,
    };
  });
}

function columnIndexForX(columns, x) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < columns.length; i++) {
    const dist = Math.abs(x - columns[i].centerX);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

// ---------- נקודת הכניסה ----------
// מחזיר { rows: string[][] } - אותו פורמט בדיוק כמו xlsxParser/csvParser/htmlTableParser, מוכן
// להזנה ל-importMapping.rowsToTransactions. זורק שגיאה עברית ברורה במקרים לא-נתמכים (מוצפן/סרוק).
function parsePdf(buffer) {
  const pdfText = buffer.toString("latin1");

  if (/\/Encrypt\s+\d+\s+0\s+R/.test(pdfText)) {
    throw new Error("קובץ ה-PDF מוצפן/מוגן בסיסמה - לא נתמך. הסירו את ההגנה (בדרך כלל דרך תוכנת ה-PDF שלכם) ונסו שוב.");
  }

  const cmap = findFontCMap(buffer, pdfText);
  if (!cmap) {
    throw new Error("לא נמצא טקסט הניתן לחילוץ בקובץ ה-PDF הזה (ייתכן שזהו מסמך סרוק/תמונה, לא טקסט אמיתי) - ייבוא כזה לא נתמך כרגע.");
  }

  // כל אובייקטי ה-/Contents (זרמי תוכן של עמודים) - לא תלויים במבנה /Pages פורמלי, רק בקיום
  // /Type/Page עם /Contents שמצביע לאובייקט stream. גישה סלחנית שעובדת גם אם עץ העמודים מורכב.
  const pageContentNums = [];
  for (const n of findAllObjectNumbers(pdfText)) {
    const o = getObjectRaw(pdfText, n);
    if (!o) continue;
    const dictOnly = o.raw.split("stream")[0];
    if (/\/Type\s*\/Page(?!s)\b/.test(dictOnly)) {
      const m = /\/Contents\s+(\d+)\s+0\s+R/.exec(dictOnly);
      if (m) pageContentNums.push(m[1]);
    }
  }
  if (!pageContentNums.length) {
    throw new Error("לא נמצאו עמודים תקינים בקובץ ה-PDF");
  }

  let headerColumns = null;
  const allRows = [];
  for (const contentNum of pageContentNums) {
    const bytes = getStreamBytes(buffer, pdfText, contentNum);
    if (!bytes) continue;
    const runs = extractTextRuns(bytes.toString("latin1"), cmap);
    const rows = groupIntoRows(runs);

    if (!headerColumns) {
      const headerIdx = findHeaderRowIndex(rows);
      if (headerIdx >= 0) {
        // השורה שמיד אחרי הכותרת: אם היא לא שורת נתונים אמיתית (בלי תאריך תקין בעמודה הראשונה
        // שהכותרת מצביעה אליה) - מתייחסים אליה כהמשך-כותרת דו-שורתי (ר' הערה ב-buildColumnBoundaries).
        // בודקים רק את הריצה הימנית ביותר (x הכי גבוה) - בשורת נתונים אמיתית זו תמיד תחילת התאריך
        // (ספרה), ובשורת המשך-כותרת זו אות עברית (למשל תחילת "העסקה"). בדיקה ממוקדת יותר מסתם
        // ספירת ריצות - כי גם שורת המשך יכולה להכיל הרבה ריצות בודדות (תו-תו, כמו כל טקסט עברי כאן).
        const maybeContinuation = rows[headerIdx + 1];
        const rightmostRun = maybeContinuation && maybeContinuation.runs.length
          ? [...maybeContinuation.runs].sort((a, b) => b.x - a.x)[0]
          : null;
        const looksLikeContinuation = maybeContinuation && rightmostRun && !/\d/.test(rightmostRun.text);
        headerColumns = buildColumnBoundaries(rows[headerIdx], looksLikeContinuation ? maybeContinuation : null);
      }
    }
    if (!headerColumns) continue; // עמוד בלי כותרות זוהות עדיין - מדלגים (למשל עמוד ראשון תקציר)

    for (const row of rows) {
      const cells = new Array(headerColumns.length).fill("");
      const byColumn = new Map();
      for (const r of row.runs) {
        const colIdx = columnIndexForX(headerColumns, r.x);
        if (!byColumn.has(colIdx)) byColumn.set(colIdx, []);
        byColumn.get(colIdx).push(r);
      }
      for (const [colIdx, colRuns] of byColumn) {
        cells[colIdx] = reorderRunsForReading([...colRuns].sort((a, b) => b.x - a.x));
      }
      allRows.push(cells);
    }
  }

  if (!headerColumns) {
    throw new Error("לא זוהתה שורת כותרות מוכרת (תאריך/סכום/תיאור) באף עמוד בקובץ ה-PDF");
  }

  // שורת הכותרות עצמה (עם התוויות שזוהו) קודמת לכל שאר השורות - כדי ש-rowsToTransactions
  // (שמצפה לשורת כותרות ממשית בתחילת המטריצה) יזהה אותה כרגיל.
  return { rows: [headerColumns.map(c => c.label), ...allRows] };
}

module.exports = { parsePdf, reorderRunsForReading, parseToUnicodeCMap };
