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
  // תוקן (נבדק מול קובץ בנק אמיתי נוסף - מזרחי טפחות): "פרטים" הוא עמודת התיאור הכי מדויקת כשהיא
  // מלאה (למשל "לטובת: ..."), אבל היא ריקה בהרבה שורות (הוראות קבע/עמלות וכו') - שם "הפעולה" (למשל
  // "הו\"ק הלו' רבית", "זיכוי מהמזרחי") היא בפועל התיאור השימושי היחיד. לכן זו לא ברשימת description
  // הראשית (שהייתה "מנצחת" לפי סדר עמודות) אלא רשימת גיבוי נפרדת - ר' descFallbackCol ב-rowsToTransactions.
  descriptionFallback: ["הפעולה", "action", "operation"],
  // תוקן (נבדק מול קובץ בנק אמיתי נוסף - בנק לאומי): "תיאור" שם הוא כמעט תמיד עמודה גנרית ולא-ריקה
  // ("כרטיס דביט" לעשרות שורות שונות לגמרי) - ההפך מ-descriptionFallback: כאן העמודה השימושית באמת
  // ("תאור מורחב", למשל "TRANSFER TO: MIZRAHI TEFAHOT BANK...") היא זו שלפעמים ריקה, ו**עדיפה כשהיא
  // כן מלאה** - לא רק גיבוי לכשהראשית ריקה. לכן זו רשימה שלישית נפרדת (descExtendedCol), עם כיוון
  // עדיפות הפוך מ-descriptionFallback - ר' rowsToTransactions.
  descriptionExtended: ["מורחב", "extended"],
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

// כמו findColumn, אבל כשיש כמה עמודות שתואמות (למשל כרטיס אשראי עם "סכום עסקה" *וגם* "סכום חיוב" -
// ר' pdfParser.js, נבדק מול קובץ אמיתי) מעדיפים את זו שמכילה גם אחת ממילות ה-preferKeywords.
// "סכום חיוב" (הסכום שבפועל מחויב החודש) עדיף בבירור על "סכום עסקה" (הסכום המקורי - יכול לכלול
// תשלומים עתידיים/המרת מטבע שלא רלוונטיים לחודש הנוכחי) לצורך מעקב תקציב. מחזיר גם את העמודה
// השנייה (לא-מועדפת) בתור fallback - נבדק מול קובץ אמיתי (מזרחי-טפחות, כרטיס ויזה) שבו "סכום חיוב"
// דווקא **ריק** בשורות "עסקה בתהליך קליטה" (עדיין לא סוכם חיוב סופי) - שם "סכום עסקה" הוא הסכום
// היחיד שקיים בפועל לאותה שורה ספציפית, אז כדאי ליפול חזרה אליו רק לשורות כאלה (ר' rowsToTransactions).
function findColumnPreferred(headerRow, keywords, preferKeywords) {
  let firstMatch = -1;
  let preferredMatch = -1;
  for (let i = 0; i < headerRow.length; i++) {
    const cell = normalizeHeaderCell(headerRow[i]);
    if (!cell || !keywords.some(k => cell.includes(k.toLowerCase()))) continue;
    if (firstMatch < 0) firstMatch = i;
    if (preferredMatch < 0 && preferKeywords.some(k => cell.includes(k.toLowerCase()))) preferredMatch = i;
  }
  const col = preferredMatch >= 0 ? preferredMatch : firstMatch;
  const fallbackCol = preferredMatch >= 0 && firstMatch >= 0 && firstMatch !== preferredMatch ? firstMatch : -1;
  return { col, fallbackCol };
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
  // מעדיפים "סכום חיוב" (הסכום שבפועל מחויב) על "סכום עסקה" (הסכום המקורי) אם שתיהן קיימות - ר' הערה ב-findColumnPreferred.
  const amount = findColumnPreferred(headerRow, HEADER_KEYWORDS.amount, ["חיוב"]);
  return {
    dateCol: findColumn(headerRow, HEADER_KEYWORDS.date),
    descCol: findColumn(headerRow, HEADER_KEYWORDS.description),
    descFallbackCol: findColumn(headerRow, HEADER_KEYWORDS.descriptionFallback),
    descExtendedCol: findColumn(headerRow, HEADER_KEYWORDS.descriptionExtended),
    creditCol: findColumn(headerRow, HEADER_KEYWORDS.credit),
    debitCol: findColumn(headerRow, HEADER_KEYWORDS.debit),
    amountCol: amount.col,
    amountFallbackCol: amount.fallbackCol,
    balanceCol: findColumn(headerRow, HEADER_KEYWORDS.balance),
  };
}

// מנקה סכום שהגיע כטקסט חופשי (מ-CSV, תא אקסל שמעוצב כטקסט, או שורת PDF שחולצה): מסיר סימני
// מטבע/פסיקי אלפים/רווחים, ומטפל בסוגריים כסימון שלילי מקובל בדוחות חשבונאיים - "(120.00)" == -120.
// תוקן (נבדק מול קובץ PDF אמיתי - כאל): שולפים רק את *הטוקן המספרי הראשון* בתוך הטקסט, לא ממירים
// את כל המחרוזת למספר - כי שחזור טקסט מ-PDF לפעמים מצרף לשורה גם הערה טקסטואלית סמוכה (כמו "הנחה
// קבועה") שנופלת קרוב מדי בקואורדינטות ל-y של שורת הסכום עצמה. חיפוש הטוקן המספרי הראשון מתעלם
// מהזבל הזה בלי לאבד את הסכום האמיתי.
function parseAmountValue(raw) {
  if (typeof raw === "number") return raw;
  const s = String(raw ?? "").trim();
  if (!s) return NaN;
  const negativeByParens = /^\(.*\)$/.test(s);
  const m = /-?[\d,]*\d(?:\.\d+)?/.exec(s.replace(/[₪$€]/g, ""));
  if (!m) return NaN;
  const n = Number(m[0].replace(/,/g, ""));
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

// תוקן (נבדק מול קובץ Excel אמיתי - דף "עובר ושב"): חלק מהבנקים משאירים את כותרות עמודות הסכום/
// היתרה *ריקות לגמרי* בייצוא (העמודות עצמן קיימות ומכילות מספרים אמיתיים לכל שורה - פשוט בלי
// טקסט כותרת בכלל, כנראה כי הבנק סומך על מיקום/עיצוב ולא על טקסט). אם זיהוי לפי מילות-מפתח לא
// מצא שום עמודת סכום, מנסים ניחוש לפי תוכן בפועל: סורקים כמה שורות נתונים ומחפשים עמודות (שעדיין
// לא "תפוסות" ע"י dateCol/descCol) שרוב הערכים בהן הם מספריים. **בין העמודות המספריות שנמצאו
// לוקחים את זו הראשונה** (אינדקס נמוך יותר) כעמודת "סכום" - בפריסה טיפוסית של דף בנק, עמודת הסכום
// (שמשתנה בסימן/גודל בין שורה לשורה) מופיעה *לפני* עמודת היתרה הרצה (balance, שמצטברת בהדרגה) -
// אם יש שתי עמודות מספריות ריקות-כותרת סמוכות, השנייה נשארת פשוט לא מזוהה (balanceCol), וזה בסדר
// כי היא לא נחוצה לחישוב התנועה עצמה.
function guessUnlabeledAmountColumn(rows, headerIndex, claimedCols) {
  const sampleRows = rows.slice(headerIndex + 1, headerIndex + 11).filter(r => r && r.some(c => c !== "" && c !== undefined && c !== null));
  if (!sampleRows.length) return -1;
  const numCols = rows[headerIndex] ? rows[headerIndex].length : 0;
  for (let c = 0; c < numCols; c++) {
    if (claimedCols.has(c)) continue;
    let numericCount = 0, dateLikeCount = 0, total = 0;
    for (const row of sampleRows) {
      const cell = row[c];
      if (cell === "" || cell === undefined || cell === null) continue;
      total++;
      // תוקן (נבדק מול קובץ אמיתי): מחרוזת תאריך כמו "2026-08-21" "מצליחה" להיקרא כמספר (2026) לפי
      // parseAmountValue (שמחפש רק את הטוקן המספרי הראשון) - בלי הבדיקה הזו, עמודת "תאריך ערך" נוספת
      // (לא רק dateCol הרשמית) הייתה מזוהה בטעות כעמודת סכום, לפני שמגיעים בכלל לעמודה המספרית האמיתית.
      if (normalizeDateValue(cell)) { dateLikeCount++; continue; }
      if (!Number.isNaN(parseAmountValue(cell))) numericCount++;
    }
    if (total >= 2 && dateLikeCount / total < 0.5 && numericCount / total >= 0.8) return c; // העמודה המספרית (לא-תאריך) הראשונה שנמצאה
  }
  return -1;
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
  // תוקן (נבדק מול קובץ בנק אמיתי - מזרחי טפחות, ייצוא PDF): לבנק הזה עמודת סכום *אחת* משולבת
  // בשם "זכות/חובה" (ולא שתי עמודות נפרדות) - "זכות" ו"חובה" שתיהן תואמות למילות המפתח שלהן, כך
  // ש-creditCol ו-debitCol מצביעות בטעות על *אותה* עמודה. בלי התיקון, נתיב הזכות/חובה למטה קורא את
  // אותו ערך פעמיים (unicode ל-credit וגם ל-debit) - ערך שלילי (למשל "הלוואה- פרעון" -305.05) לא
  // עובר אף אחד מהתנאים (לא credit>0 ולא debit>0) ונופל בשקט, כך שכל שורות ההוצאה נעלמות מהייבוא.
  // מבטלים את שני הזיהויים הכוזבים כדי שהעמודה תיפול לניחוש guessUnlabeledAmountColumn (לפי תוכן,
  // סימן שלילי=הוצאה) - בדיוק כמו עמודת סכום בודדת רגילה.
  if (cols.creditCol >= 0 && cols.creditCol === cols.debitCol) {
    cols.creditCol = -1;
    cols.debitCol = -1;
  }
  if (cols.dateCol < 0) {
    return { error: "לא נמצאה עמודת תאריך בקובץ - לא ניתן לייבא בלי תאריך לכל תנועה." };
  }
  if (cols.creditCol < 0 && cols.debitCol < 0 && cols.amountCol < 0) {
    // ר' הערה מפורטת ב-guessUnlabeledAmountColumn - חלק מהבנקים משאירים כותרת עמודת הסכום ריקה.
    const claimed = new Set(
      [cols.dateCol, cols.descCol, cols.descFallbackCol, cols.descExtendedCol, cols.amountFallbackCol, cols.balanceCol].filter(
        (c) => c >= 0
      )
    );
    cols.amountCol = guessUnlabeledAmountColumn(rows, headerIndex, claimed);
    if (cols.amountCol < 0) {
      return { error: "לא נמצאה עמודת סכום (או זכות/חובה) בקובץ." };
    }
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
    // תוקן (נבדק מול קובץ אמיתי - כאל): דורשים ששתי העמודות זכות/חובה יימצאו *יחד* כדי לבחור
    // במסלול הזה - זה מבנה עו"ש אמיתי (יש תמיד את שתיהן, כסף או נכנס או יוצא). אם נמצאה רק אחת מהן
    // בלבד (למשל "סכום חיוב" בכרטיס אשראי - שם "חיוב" תואם גם למילות המפתח של debit במקרה), זה כנראה
    // באמת עמודת סכום בודדת (ר' amountCol/findColumnPreferred למעלה) ולא זוג זכות/חובה אמיתי.
    if (cols.creditCol >= 0 && cols.debitCol >= 0) {
      const credit = cols.creditCol >= 0 ? parseAmountValue(row[cols.creditCol]) : 0;
      const debit = cols.debitCol >= 0 ? parseAmountValue(row[cols.debitCol]) : 0;
      if (credit > 0) { amount = credit; type = "income"; }
      else if (debit > 0) { amount = Math.abs(debit); type = "expense"; }
      else continue; // שתי העמודות ריקות/אפס - לא תנועה אמיתית (למשל שורת סיכום)
    } else {
      let raw = parseAmountValue(row[cols.amountCol]);
      // עמודת הסכום המועדפת ריקה לשורה הזו ספציפית (למשל "סכום חיוב" עוד לא נקבע - עסקה "בתהליך
      // קליטה" שטרם סוכם החיוב הסופי שלה) - נופלים חזרה לעמודת הסכום השנייה (למשל "סכום עסקה"),
      // בדיוק כמו ש-descFallbackCol עובד לתיאור: לא כל שורה מכריעה איזו עמודה "מנצחת" ברמת הקובץ
      // כולו, אלא כל שורה בפני עצמה. ר' הערה ב-findColumnPreferred.
      if (Number.isNaN(raw) && cols.amountFallbackCol >= 0) {
        raw = parseAmountValue(row[cols.amountFallbackCol]);
      }
      if (Number.isNaN(raw) || raw === 0) continue;
      if (sourceType === "card") {
        type = raw < 0 ? "income" : "expense";
      } else {
        type = raw < 0 ? "expense" : "income";
      }
      amount = Math.abs(raw);
    }
    if (Number.isNaN(amount) || amount <= 0) { skipped.push({ rowIndex: i, reason: "סכום לא תקין" }); continue; }

    // סדר עדיפות לתיאור: (1) descExtendedCol - "מורחב"/"extended", עדיף *כל אימת שהוא מלא* (ר' הערה
    // ב-HEADER_KEYWORDS.descriptionExtended - זו העמודה עם הפרטים השימושיים באמת, כשקיימים). (2)
    // descCol הראשי. (3) descFallbackCol - "הפעולה" וכדומה, רק כש-descCol עצמו ריק לשורה הזו.
    const extendedDescription = cols.descExtendedCol >= 0 ? String(row[cols.descExtendedCol] ?? "").trim() : "";
    let description = extendedDescription || (cols.descCol >= 0 ? String(row[cols.descCol] ?? "").trim() : "");
    if (!description && cols.descFallbackCol >= 0) {
      description = String(row[cols.descFallbackCol] ?? "").trim();
    }

    // משוב אמיתי: "בדפי הבנק יש פרטים שלאחר יבוא לא רואים אותם - אני צריך את כל הנתונים בצד". עד
    // כה נבחרו רק עמודות date/description/amount/type מהשורה - כל שאר העמודות המקוריות (מספר
    // אסמכתא, יתרה, ניסוח מדויק של סוג הפעולה וכו') פשוט הושלכו ולא נשמרו בשום מקום. raw שומר כאן
    // *כל* עמודה בשורה (לפי תווית הכותרת שלה), כדי שאפשר יהיה להציג אותה תוך כדי עריכה בתצוגה
    // המקדימה (ר' rawDataDetailsHtml ב-public/app.html) וגם אחרי היבוא בפועל (נשמר כ-raw_data,
    // ר' routes/importTransactions.js/db.js). מדלגים על תאים ריקים - אין טעם להציג "עמודה 7: " ריק.
    const raw = headerRow
      .map((h, ci) => ({ label: String(h ?? "").trim() || `עמודה ${ci + 1}`, value: row[ci] }))
      .filter(c => c.value !== "" && c.value !== undefined && c.value !== null);

    transactions.push({ date, description, amount: Math.round(amount * 100) / 100, type, category: "", raw });
  }

  return { headerIndex, columns: cols, transactions, skippedCount: skipped.length };
}

module.exports = { detectColumns, findHeaderRowIndex, rowsToTransactions, parseAmountValue, normalizeDateValue };
