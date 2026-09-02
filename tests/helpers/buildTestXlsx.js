// buildTestXlsx.js — כלי עזר לבדיקות בלבד: בונה קובץ .xlsx מינימלי ותקין-מבנית ביד (בלי Excel/ספרייה
// חיצונית), כדי לבדוק את xlsxParser.js מקצה לקצה בלי להזדקק לקובץ Excel אמיתי בפרויקט. משתמש
// בדחיסת "store" (ללא דחיסה בפועל) בלבד לפשטות - xlsxParser.js תומך גם ב-DEFLATE (ר' שם), אבל אין
// צורך לבדוק את זה כאן כי zlib.inflateRawSync עצמו כבר מכוסה בהרחבה ע"י Node.
"use strict";
const zlib = require("zlib");

// deflate: false (ברירת מחדל) בונה ZIP ב"store" (בלי דחיסה) - הכי פשוט לניפוי שגיאות. deflate: true
// דוחס כל קובץ בפועל עם DEFLATE (בדיוק כמו קבצי Excel אמיתיים) - כדי לבדוק גם את נתיב הקוד ב-
// xlsxParser.js שקורא ל-zlib.inflateRawSync, לא רק את נתיב ה"store" הפשוט יותר.
function buildZip(files, { deflate = false } = {}) {
  // files: { "path/in/zip.xml": "<xml content>" }
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const rawBuf = Buffer.from(content, "utf8");
    const dataBuf = deflate ? zlib.deflateRawSync(rawBuf) : rawBuf;
    const method = deflate ? 8 : 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);   // version needed
    localHeader.writeUInt16LE(0, 6);    // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);   // mod time
    localHeader.writeUInt16LE(0, 12);   // mod date
    localHeader.writeUInt32LE(0, 14);   // crc32 - לא מאומת ע"י xlsxParser.js, מדלגים
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);   // extra field length

    const localEntry = Buffer.concat([localHeader, nameBuf, dataBuf]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);  // version made by
    centralHeader.writeUInt16LE(20, 6);  // version needed
    centralHeader.writeUInt16LE(0, 8);   // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);  // mod time
    centralHeader.writeUInt16LE(0, 14);  // mod date
    centralHeader.writeUInt32LE(0, 16);  // crc32
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);  // extra len
    centralHeader.writeUInt16LE(0, 32);  // comment len
    centralHeader.writeUInt16LE(0, 34);  // disk number
    centralHeader.writeUInt16LE(0, 36);  // internal attrs
    centralHeader.writeUInt32LE(0, 38);  // external attrs
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localEntry.length;
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16); // offset of central directory
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// בונה .xlsx עם גיליון יחיד, מרשימת שורות (מערך של מערכי מחרוזות/מספרים), ועמודת תאריך אחת
// (dateColIndex, 0-based) שמעוצבת בפועל כתאריך (numFmtId=14, פורמט מובנה) - כדי לבדוק גם את
// זיהוי סגנון-התא, לא רק את ערך התא הגולמי.
// namespacePrefix (אופציונלי, למשל "x") - בונה את כל ה-XML עם קידומת namespace על כל תגית
// (<x:row>/<x:c>/<x:v>/<x:sheetData>/<x:sheet>/...) במקום ברירת המחדל בלי קידומת - כדי לבדוק את
// הסבלנות ל-namespace ב-xlsxParser.js (נבדק מול קובץ אמיתי - מזרחי-טפחות, כרטיס ויזה - שכתוב כך).
function buildTestXlsx(rows, dateColIndex, { deflate = false, namespacePrefix = "" } = {}) {
  const p = namespacePrefix ? `${namespacePrefix}:` : "";
  const sharedStrings = [];
  function sharedStringIndex(text) {
    let idx = sharedStrings.indexOf(text);
    if (idx < 0) { sharedStrings.push(text); idx = sharedStrings.length - 1; }
    return idx;
  }
  function colLetters(n) {
    let s = "";
    n += 1;
    while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  const rowsXml = rows
    .map((row, rIdx) => {
      const cellsXml = row
        .map((cell, cIdx) => {
          const ref = `${colLetters(cIdx)}${rIdx + 1}`;
          if (cell === null) return `<${p}c r="${ref}" t="s" />`; // תא ריק לגמרי - בלי <v> בכלל (ר' הערה ב-xlsxParser.js)
          if (typeof cell === "number") {
            const style = cIdx === dateColIndex ? ' s="1"' : "";
            return `<${p}c r="${ref}"${style}><${p}v>${cell}</${p}v></${p}c>`;
          }
          const s = sharedStringIndex(String(cell));
          return `<${p}c r="${ref}" t="s"><${p}v>${s}</${p}v></${p}c>`;
        })
        .join("");
      return `<${p}row r="${rIdx + 1}">${cellsXml}</${p}row>`;
    })
    .join("");

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}worksheet xmlns${namespacePrefix ? `:${namespacePrefix}` : ""}="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><${p}sheetData>${rowsXml}</${p}sheetData></${p}worksheet>`;

  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}sst xmlns${namespacePrefix ? `:${namespacePrefix}` : ""}="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings
    .map(s => `<${p}si><${p}t>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</${p}t></${p}si>`)
    .join("")}</${p}sst>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}styleSheet xmlns${namespacePrefix ? `:${namespacePrefix}` : ""}="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<${p}cellXfs count="2"><${p}xf numFmtId="0"/><${p}xf numFmtId="14"/></${p}cellXfs>
</${p}styleSheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}workbook xmlns${namespacePrefix ? `:${namespacePrefix}` : ""}="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<${p}sheets><${p}sheet name="Sheet1" sheetId="1" r:id="rId1"/></${p}sheets>
</${p}workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  return buildZip(
    {
      "[Content_Types].xml": contentTypesXml,
      "_rels/.rels": rootRelsXml,
      "xl/workbook.xml": workbookXml,
      "xl/_rels/workbook.xml.rels": workbookRelsXml,
      "xl/worksheets/sheet1.xml": sheetXml,
      "xl/sharedStrings.xml": sstXml,
      "xl/styles.xml": stylesXml,
    },
    { deflate }
  );
}

module.exports = { buildTestXlsx, buildZip };
