// xlsxParser.js — קורא קבצי Excel (.xlsx) בלי שום ספרייה חיצונית (עקרון הפרויקט: אין תלויות npM).
// נבנה לצורך "ייבוא אקסל" של דפי בנק/כרטיס אשראי (ר' routes/importTransactions.js) - משוב אמיתי
// ממשתמש: "רוצה להכניס אקסל של דפי בנק או דפי כרטיס אשראי, שיוכל להוריד אותו והמערכת תכניס את זה
// להכנסות והוצאות".
//
// קובץ .xlsx הוא בעצם ארכיון ZIP רגיל שמכיל כמה קבצי XML. בלי ספריית zip/xml חיצונית, מפרקים
// את שניהם ביד:
//   (1) ZIP: קוראים את "רשומת סיום התיקייה המרכזית" (End Of Central Directory) מסוף הקובץ, ודרכה
//       את "התיקייה המרכזית" - רשימת כל הקבצים בארכיון ומיקומם. דחיסה נתמכת: ללא דחיסה (0) ו-DEFLATE
//       (8, באמצעות zlib.inflateRawSync המובנה ב-Node - בלי ספרייה חיצונית).
//   (2) XML: קבצי ה-XML הרלוונטיים (xl/worksheets/sheetN.xml, xl/sharedStrings.xml, xl/styles.xml)
//       הם שטוחים ופשוטים מספיק כדי לפרק אותם עם ביטויים רגולריים, בלי פרסר DOM מלא.
"use strict";
const zlib = require("zlib");

// ---------- שכבה 1: קריאת ZIP גולמי ----------
function readZip(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  const searchStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error("קובץ ה-Excel פגום או שאינו בפורמט xlsx תקין (לא נמצא סוף ארכיון ZIP)");

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const CD_SIG = 0x02014b50;
  const meta = {};
  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CD_SIG) throw new Error("קובץ ה-Excel פגום (רשומת תיקייה מרכזית שגויה ב-ZIP)");
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const fileNameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const fileName = buf.toString("utf8", offset + 46, offset + 46 + fileNameLen);
    meta[fileName] = { compressionMethod, compressedSize, localHeaderOffset };
    offset += 46 + fileNameLen + extraLen + commentLen;
  }

  function readEntry(name) {
    const m = meta[name];
    if (!m) return null;
    const LFH_SIG = 0x04034b50;
    if (buf.readUInt32LE(m.localHeaderOffset) !== LFH_SIG) {
      throw new Error("קובץ ה-Excel פגום (כותרת קובץ מקומית שגויה ב-ZIP)");
    }
    const nameLen = buf.readUInt16LE(m.localHeaderOffset + 26);
    const extraLen = buf.readUInt16LE(m.localHeaderOffset + 28);
    const dataStart = m.localHeaderOffset + 30 + nameLen + extraLen;
    const compressed = buf.subarray(dataStart, dataStart + m.compressedSize);
    if (m.compressionMethod === 0) return Buffer.from(compressed);
    if (m.compressionMethod === 8) return zlib.inflateRawSync(compressed);
    throw new Error(`שיטת דחיסה לא נתמכת בקובץ ה-Excel (קוד ${m.compressionMethod}) - נסו לשמור מחדש כ-xlsx רגיל`);
  }

  return { names: Object.keys(meta), readEntry };
}

// ---------- שכבה 2: פענוח XML מינימלי (ביטויים רגולריים בלבד, בלי DOM) ----------
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const items = [];
  const siRegex = /<si[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRegex.exec(xml))) {
    const texts = [];
    const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRegex.exec(m[1]))) texts.push(decodeXmlEntities(tm[1]));
    items.push(texts.join(""));
  }
  return items;
}

// numFmtId מובנים של Excel ששייכים לתאריך/שעה (ר' תקן ECMA-376, חלק 1, סעיף 18.8.30).
const BUILTIN_DATE_NUMFMT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

// עבור numFmt מותאם-אישית (numFmtId>=164) - בודקים אם קוד הפורמט "נראה כמו" תאריך/שעה (מכיל אותיות
// y/m/d/h/s מחוץ למרכאות) ולא רק פורמט מספרי רגיל (כמו "#,##0.00").
function looksLikeDateFormatCode(code) {
  const withoutQuoted = String(code || "").replace(/"[^"]*"/g, "");
  return /[ymdhs]/i.test(withoutQuoted);
}

function parseStyles(xml) {
  if (!xml) return [];
  const customFormats = {};
  const numFmtRegex = /<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/>/g;
  let m;
  while ((m = numFmtRegex.exec(xml))) {
    customFormats[m[1]] = looksLikeDateFormatCode(decodeXmlEntities(m[2]));
  }

  const cellXfsMatch = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!cellXfsMatch) return [];
  const xfRegex = /<xf\b[^>]*\/?>/g;
  const styleIsDate = [];
  let xm;
  while ((xm = xfRegex.exec(cellXfsMatch[1]))) {
    const idMatch = /numFmtId="(\d+)"/.exec(xm[0]);
    const numFmtId = idMatch ? Number(idMatch[1]) : 0;
    if (numFmtId in customFormats) styleIsDate.push(customFormats[numFmtId]);
    else styleIsDate.push(BUILTIN_DATE_NUMFMT_IDS.has(numFmtId));
  }
  return styleIsDate;
}

// ממיר מספר סידורי של תאריך אקסל (ימים מאז 1899-12-30, כולל "תיקון" באג שנת-2000 המפורסם של
// אקסל) לתאריך ISO (YYYY-MM-DD). שימוש ב-1899-12-30 כאפוק (ולא 1899-12-31) מפצה אוטומטית על
// הבאג הזה בלי צורך בתיקון נפרד.
function excelSerialToIsoDate(serial) {
  const ms = Date.UTC(1899, 11, 30) + Math.round(Number(serial)) * 86400000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function colLettersToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // 0-based
}

function parseSheetRows(xml, sharedStrings, styleIsDate) {
  const sheetDataMatch = /<sheetData[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml);
  if (!sheetDataMatch) return [];
  const rows = [];
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRegex.exec(sheetDataMatch[1]))) {
    const cells = [];
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRegex.exec(rm[1]))) {
      const attrs = cm[1] || "";
      const inner = cm[2] || "";
      const refMatch = /r="([A-Z]+)\d+"/.exec(attrs);
      if (!refMatch) continue;
      const colIndex = colLettersToIndex(refMatch[1]);
      const typeMatch = /t="([a-zA-Z]+)"/.exec(attrs);
      const type = typeMatch ? typeMatch[1] : null;
      const styleMatch = /s="(\d+)"/.exec(attrs);
      const styleIndex = styleMatch ? Number(styleMatch[1]) : 0;

      let value = "";
      if (type === "inlineStr") {
        const isMatch = /<is>([\s\S]*?)<\/is>/.exec(inner);
        const tMatch = isMatch ? /<t[^>]*>([\s\S]*?)<\/t>/.exec(isMatch[1]) : null;
        value = tMatch ? decodeXmlEntities(tMatch[1]) : "";
      } else {
        const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vMatch ? decodeXmlEntities(vMatch[1]) : "";
        if (type === "s") {
          value = sharedStrings[Number(raw)] ?? "";
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : "FALSE";
        } else if (type === "str" || type === "e") {
          value = raw;
        } else if (raw === "") {
          value = "";
        } else if (styleIsDate[styleIndex]) {
          value = excelSerialToIsoDate(raw);
        } else {
          value = Number(raw);
        }
      }
      cells[colIndex] = value;
    }
    // ממלאים תאים ריקים באמצע השורה (שלא הופיעו בכלל ב-XML) ב-"" כדי לשמור על יישור עמודות קבוע.
    const maxIndex = cells.length - 1;
    const filled = [];
    for (let i = 0; i <= maxIndex; i++) filled.push(cells[i] === undefined ? "" : cells[i]);
    rows.push(filled);
  }
  return rows;
}

// מוצא את קובץ ה-XML של הגיליון הראשון בארכיון. מנסה לפי workbook.xml + workbook.xml.rels (הדרך
// ה"נכונה" - סדר הגיליונות שם לא בהכרח תואם למספור sheetN.xml בפועל), עם נפילה חזרה ל-sheet1.xml
// הפשוט אם המבנה לא כמצופה - מספיק לרוב הגדול של קבצי ייצוא בנק/כרטיס אשראי (גיליון יחיד).
function findFirstSheetPath(zip) {
  try {
    const workbookXml = zip.readEntry("xl/workbook.xml")?.toString("utf8");
    const relsXml = zip.readEntry("xl/_rels/workbook.xml.rels")?.toString("utf8");
    if (workbookXml && relsXml) {
      const sheetMatch = /<sheet\b[^>]*r:id="([^"]+)"[^>]*\/>/.exec(workbookXml) || /<sheet\b[^>]*\/>/.exec(workbookXml);
      const ridMatch = sheetMatch ? /r:id="([^"]+)"/.exec(sheetMatch[0]) : null;
      if (ridMatch) {
        const relRegex = new RegExp(`<Relationship[^>]*Id="${ridMatch[1]}"[^>]*Target="([^"]+)"[^>]*/>`);
        const relMatch = relRegex.exec(relsXml);
        if (relMatch) {
          const target = relMatch[1].replace(/^\/?/, "");
          return target.startsWith("xl/") ? target : `xl/${target}`;
        }
      }
    }
  } catch (e) {
    // מתעלמים ונופלים חזרה לברירת המחדל למטה
  }
  return "xl/worksheets/sheet1.xml";
}

// נקודת הכניסה: מקבל Buffer של קובץ .xlsx, מחזיר מטריצת שורות (מערך של מערכי ערכים - טקסט/מספר/
// תאריך כ-ISO), מהגיליון הראשון בלבד (מספיק בהחלט לייצוא בנק/כרטיס אשראי טיפוסי).
function parseXlsx(buffer) {
  const zip = readZip(buffer);
  const sharedStringsXml = zip.readEntry("xl/sharedStrings.xml")?.toString("utf8");
  const stylesXml = zip.readEntry("xl/styles.xml")?.toString("utf8");
  const sheetPath = findFirstSheetPath(zip);
  const sheetXml = zip.readEntry(sheetPath)?.toString("utf8") || zip.readEntry("xl/worksheets/sheet1.xml")?.toString("utf8");
  if (!sheetXml) throw new Error("לא נמצא גיליון עבודה בקובץ ה-Excel");

  const sharedStrings = parseSharedStrings(sharedStringsXml);
  const styleIsDate = parseStyles(stylesXml);
  return parseSheetRows(sheetXml, sharedStrings, styleIsDate);
}

module.exports = { parseXlsx, excelSerialToIsoDate };
