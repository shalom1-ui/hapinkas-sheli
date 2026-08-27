// buildTestPdf.js — כלי עזר לבדיקות בלבד: בונה קובץ PDF מינימלי ותקין-מבנית ביד (בלי ספרייה חיצונית
// וגם בלי Adobe/Acrobat), כדי לבדוק את pdfParser.js מקצה לקצה. משתמש בגופן CID עם מפת ToUnicode
// "זהה" (כל קוד 4-ספרות-הקס ממופה ישירות לאותה נקודת-קוד יוניקוד) - כך שאפשר לכתוב כל טקסט (כולל
// עברית) כמחרוזת hex פשוטה בזרם התוכן, בלי צורך לבנות גופן CID מלא (pdfParser.js ממילא לא קורא
// את פרטי ה-DescendantFonts - רק את /Type/Font + /ToUnicode, ר' findFontCMap).
"use strict";
const zlib = require("zlib");

// PDF תמיד שומר טקסט ב"סדר תצוגה" (visual order) - עבור RTL זה אומר שהיוצר *כבר* הפך את הריצה לפני
// כתיבתה ל-Tj (זה בעצם התפקיד של pdfParser.js/reorderRunsForReading: להחזיר את זה בחזרה לסדר קריאה
// לוגי). תוקן (נבדק מול קובץ אמיתי - מזרחי טפחות, ר' pdfParser.js): גרסה קודמת של buildTestPdf כתבה
// מחרוזות עבריות בסדר לוגי-כבר-נכון (לא ריאליסטי) - "עבד" רק כי pdfParser.js הישן לא ניסה בכלל להפוך
// ריצה עברית רב-תווית בתוך עצמה. עכשיו שזה תוקן (כדי לתמוך בקובץ אמיתי שכן כותב כך), הבדיקות היו
// נשברות בלי התיקון המקביל כאן - הופכים כל מחרוזת עברית (עם מיפוי סוגריים) לפני הקידוד, בדיוק כמו
// מפיק PDF אמיתי, כדי שה"סבב" קידוד+פענוח יישאר עקבי (ומכסה בפועל את קוד ההיפוך, לא רק "עוקף" אותו).
const MIRROR_CHARS = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{" };
function toVisualOrder(str) {
  if (!/[֐-׿]/.test(str)) return str;
  return [...str].reverse().map(c => MIRROR_CHARS[c] || c).join("");
}
function textToHex(str) {
  const visual = toVisualOrder(str);
  let hex = "";
  for (const ch of visual) {
    const code = ch.codePointAt(0);
    hex += code.toString(16).padStart(4, "0");
  }
  return `<${hex}>`;
}

// rows: [{ cells: [{ text, x, y }, ...] }, ...] - שליטה מלאה על מיקום כל תא, כדי לדמות טבלה אמיתית.
function buildTestPdf(cellPlacements) {
  const contentOps = cellPlacements
    .map(({ text, x, y }) => `BT /F 12 Tf 1 0 0 1 ${x} ${y} Tm ${textToHex(text)} Tj ET`)
    .join("\n");
  const contentRaw = Buffer.from(contentOps, "utf8");
  const contentCompressed = zlib.deflateSync(contentRaw);

  // מפת ToUnicode "זהה" - כל קוד בטווח ה-BMP ממופה לעצמו, ר' הערת הפתיחה.
  const cmapText = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "1 beginbfrange",
    "<0000> <FFFF> <0000>",
    "endbfrange",
    "endcmap",
    "end",
    "end",
  ].join("\n");
  const cmapRaw = Buffer.from(cmapText, "utf8");
  const cmapCompressed = zlib.deflateSync(cmapRaw);

  const objects = [];
  objects[1] = `<</Type/Catalog/Pages 2 0 R>>`;
  objects[2] = `<</Type/Pages/Kids [3 0 R]/Count 1>>`;
  objects[3] = `<</Type/Page/Parent 2 0 R/Resources<</Font<</F 5 0 R>>>>/Contents 4 0 R/MediaBox [0 0 600 800]>>`;
  objects[4] = { dict: `<</Length ${contentCompressed.length}/Filter/FlateDecode>>`, stream: contentCompressed };
  objects[5] = `<</Type/Font/Subtype/Type0/BaseFont/TestFont/Encoding/Identity-H/ToUnicode 6 0 R>>`;
  objects[6] = { dict: `<</Length ${cmapCompressed.length}/Filter/FlateDecode>>`, stream: cmapCompressed };

  let pdf = Buffer.from("%PDF-1.4\n", "latin1");
  const offsets = [0]; // offsets[0] unused (object 0 is always free in PDF xref)
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length;
    const obj = objects[i];
    if (typeof obj === "string") {
      pdf = Buffer.concat([pdf, Buffer.from(`${i} 0 obj\n${obj}\nendobj\n`, "latin1")]);
    } else {
      const head = Buffer.from(`${i} 0 obj\n${obj.dict}\nstream\n`, "latin1");
      const tail = Buffer.from("\nendstream\nendobj\n", "latin1");
      pdf = Buffer.concat([pdf, head, obj.stream, tail]);
    }
  }

  const xrefOffset = pdf.length;
  const count = objects.length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<</Size ${count}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;
  pdf = Buffer.concat([pdf, Buffer.from(xref + trailer, "latin1")]);

  return pdf;
}

module.exports = { buildTestPdf };
