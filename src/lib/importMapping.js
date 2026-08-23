// importMapping.js — הופך מטריצת שורות גולמית (מ-xlsxParser/csvParser, מקור לא ידוע מראש - בנקים/
// חברות כרטיסי אשראי שונים מוציאים עמודות שונות לגמרי) לרשימת תנועות (תאריך/תיאור/סכום/סוג),
// באמצעות זיהוי כותרות עמודות לפי מילות מפתח נפוצות בעברית ובאנגלית. ר' routes/importTransactions.js.
"use strict";

// כל רשימה - מילות מפתח שמספיק שאחת מהן "תופיע בתוך" תא הכותרת (לא התאמה מדויקת) כדי לזהות את
// העמודה - כי בנקים/כרטיסים שונים מנסחים כותרות דומות אך לא זהות ("תאריך" / "תאריך ערך" / "תאריך עסקה").
const HEADER_KEYWORDS = {
  date: ["תאריך", "date"],
  // "סוג תנועה"/"סוג פעולה" נוספו בעקבות קובץ בנק אמיתי (מרכנתיל-דיסקונט, ר' htmlTableParser.js) -
  // שם זו בפועל עמודת התיאור (למשל "זיכוי מידי-מרכנתיל", "משיכת מזומן ב'כספון'"), למרות השם.
  description: ["תיאור", "פרטים", "שם בית", "בית עסק", "סוג תנועה", "סוג פעולה", "detail", "description", "narration", "remarks"],
  credit: ["זכות", "credit", "הפקדה"], // "זכות"/הפקדה
  debit: ["חובה", "debit", "חיוב", "משיכה"],
  amount: ["סכום", "amount", "שקל"],
  balance: ["יתרה", "balance", "יתרת"],
};

function normalizeHeaderCell(v) {
  return String(v ?? "").trim().toLowerCase();
}

function findColumn(headerRow, keywords) {
  for (let i = 0; i < headerRow.length; i++) {
    const cell = normalizeHeaderCell(headerRow[i]);
    if (!cell) continue;
    if (keywords.some(k => cell.includes(k.toLowerCase()))) return i;
  }
  return -1;
}

// מזהה איזו שורה בקובץ היא שורת הכותרות: סורקים את 15 השורות הראשונות (חלק מהבנקים מוסיפים כמה
// שורות כותרת/תקציר לפני טבלת הנתונים בפועל) ובוחרים את זו עם הכי הרבה התאמות מילות-מפתח, כל עוד
// יש לפחות 2 התאמות (כדי לא "לתפוס" בטעות שורת נתונים רגילה).
function findHeaderRowIndex(rows) {
  let bestIndex = -1;
  let bestScore = 1; // סף מינימלי - חייבים לפחות 2 התאמות
  const scanLimit = Math.min(rows.length, 15);
  for (let i = 0; i < scanLimit; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    let score = 0;
    for (const keywords of Object.values(HEADER_KEYWORDS)) {
      if (findColumn(row, keywords) >= 0) score++;
    }
    if (score > bestScore) { bestScore = score; bestIndex = i; }
  }
  return bestIndex;
}

function detectColumns(headerRow) {
  return {
    dateCol: findColumn(headerRow, HEADER_KEYWORDS.date),
    descCol: findColumn(headerRow, HEADER_KEYWORDS.description),
    creditCol: findColumn(headerRow, HEADER_KEYWORDS.credit),
    debitCol: findColumn(headerRow, HEADER_KEYWORDS.debit),
    amountCol: findColumn(headerRow, HEADER_KEYWORDS.amount),
    balanceCol: findColumn(headerRow, HEADER_KEYWORDS.balance),
  };
}

// מנקה סכום שהגיע כטקסט חופשי (מ-CSV, או תא אקסל שמעוצב כטקסט): מסיר סימני מטבע/פסיקי אלפים/רווחים,
// ומטפל בסוגריים כסימון שלילי מקובל בדוחות חשבונאיים - "(120.00)" == -120.
function parseAmountValue(raw) {
  if (typeof raw === "number") return raw;
  let s = String(raw ?? "").trim();
  if (!s) return NaN;
  const negativeByParens = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "").replace(/[₪$€,\s]/g, "");
  const n = Number(s);
  if (Number.isNaN(n)) return NaN;
  return negativeByParens ? -Math.abs(n) : n;
}

// מנרמל תאריך שהגיע כטקסט חופשי (dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy) ל-ISO (YYYY-MM-DD). תאריכים
// שכבר הגיעו כ-ISO (מתאי אקסל שעברו המרה ב-xlsxParser) עוברים כמעט בלי שינוי.
function normalizeDateValue(raw) {
  if (raw instanceof Date) {
    return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, "0")}-${String(raw.getDate()).padStart(2, "0")}`;
  }
  const s = String(raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); // כבר ISO
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (Number(y) < 50 ? "20" : "19") + y;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null; // לא זוהה כתאריך תקין - השורה תידלג (ר' rowsToTransactions)
}

// הופך מטריצת שורות גולמית לרשימת תנועות מוכנות לתצוגה מקדימה/ייבוא.
// sourceType: 'bank' (עו"ש - ברירת מחדל להכנסה/הוצאה לפי סימן, אם אין עמודות זכות/חובה נפרדות)
//             'card' (כרטיס אשראי - ברירת מחדל "הוצאה", כי רוב השורות הן חיובים; שורה עם סכום שלילי
//             מתפרשת כזיכוי/החזר ולכן כ"הכנסה" - הנחה סבירה בלי לדעת את הפורמט המדויק של כל חברה).
function rowsToTransactions(rows, sourceType) {
  const headerIndex = findHeaderRowIndex(rows);
  if (headerIndex < 0) {
    return { error: "לא זוהתה שורת כותרות מוכרת בקובץ (תאריך/סכום/זכות/חובה). ודאו שזהו קובץ ייצוא תנועות תקין." };
  }
  const headerRow = rows[headerIndex];
  const cols = detectColumns(headerRow);
  if (cols.dateCol < 0) {
    return { error: "לא נמצאה עמודת תאריך בקובץ - לא ניתן לייבא בלי תאריך לכל תנועה." };
  }
  if (cols.creditCol < 0 && cols.debitCol < 0 && cols.amountCol < 0) {
    return { error: "לא נמצאה עמודת סכום (או זכות/חובה) בקובץ." };
  }

  const transactions = [];
  const skipped = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => c === "" || c === undefined || c === null)) continue;

    const date = normalizeDateValue(row[cols.dateCol]);
    if (!date) { skipped.push({ rowIndex: i, reason: "תאריך לא תקין" }); continue; }

    let amount = NaN;
    let type = null;
    if (cols.creditCol >= 0 || cols.debitCol >= 0) {
      const credit = cols.creditCol >= 0 ? parseAmountValue(row[cols.creditCol]) : 0;
      const debit = cols.debitCol >= 0 ? parseAmountValue(row[cols.debitCol]) : 0;
      if (credit > 0) { amount = credit; type = "income"; }
      else if (debit > 0) { amount = Math.abs(debit); type = "expense"; }
      else continue; // שתי העמודות ריקות/אפס - לא תנועה אמיתית (למשל שורת סיכום)
    } else {
      const raw = parseAmountValue(row[cols.amountCol]);
      if (Number.isNaN(raw) || raw === 0) continue;
      if (sourceType === "card") {
        type = raw < 0 ? "income" : "expense";
      } else {
        type = raw < 0 ? "expense" : "income";
      }
      amount = Math.abs(raw);
    }
    if (Number.isNaN(amount) || amount <= 0) { skipped.push({ rowIndex: i, reason: "סכום לא תקין" }); continue; }

    const description = cols.descCol >= 0 ? String(row[cols.descCol] ?? "").trim() : "";
    transactions.push({ date, description, amount: Math.round(amount * 100) / 100, type, category: "" });
  }

  return { headerIndex, columns: cols, transactions, skippedCount: skipped.length };
}

module.exports = { detectColumns, findHeaderRowIndex, rowsToTransactions, parseAmountValue, normalizeDateValue };
