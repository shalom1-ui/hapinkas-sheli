// csvParser.js — פרסר CSV מינימלי, בלי ספרייה חיצונית (לצורך "ייבוא" דפי בנק/כרטיס אשראי שהורדו
// כ-CSV במקום xlsx - ר' routes/importTransactions.js). תומך בשדות מצוטטים (עם פסיקים/שורות חדשות
// בפנים, ו-"" בתור מרכאה בודדת בתוך שדה מצוטט), ומזהה אוטומטית את המפריד (פסיק/נקודה-פסיק/טאב) -
// חלק מהבנקים בישראל מייצאים עם נקודה-פסיק במקום פסיק.
"use strict";

function detectDelimiter(headerLine) {
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const c of candidates) {
    const count = headerLine.split(c).length - 1;
    if (count > bestCount) { bestCount = count; best = c; }
  }
  return best;
}

function parseCsv(text) {
  // מסירים BOM (Byte Order Mark) בתחילת הקובץ, אם קיים - נפוץ בקבצים שנשמרו מ-Excel/Windows.
  const clean = String(text || "").replace(/^﻿/, "");
  if (!clean.trim()) return [];

  const firstLineEnd = clean.search(/\r\n|\n/);
  const headerLine = firstLineEnd >= 0 ? clean.slice(0, firstLineEnd) : clean;
  const delimiter = detectDelimiter(headerLine);

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = clean.length;

  function endField() { row.push(field); field = ""; }
  function endRow() { endField(); rows.push(row); row = []; }

  while (i < n) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { endField(); i++; continue; }
    if (ch === "\r") { i++; continue; } // מתעלמים, \n מטפל בסיום השורה בפועל
    if (ch === "\n") { endRow(); i++; continue; }
    field += ch; i++;
  }
  // שורה אחרונה בלי \n בסוף הקובץ
  if (field !== "" || row.length > 0) endRow();

  return rows.filter(r => !(r.length === 1 && r[0].trim() === "")); // מדלגים על שורות ריקות לגמרי
}

module.exports = { parseCsv };
