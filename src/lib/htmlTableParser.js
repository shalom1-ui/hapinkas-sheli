// htmlTableParser.js — קורא "אקסל" שהוא בעצם טבלת HTML פשוטה שנשמרה עם סיומת .xls/.xlsx.
// תוקן בעקבות קובץ אמיתי מהמשתמש ("AccountActivity.xls" מבנק מרכנתיל-דיסקונט): זהו טריק ותיק
// ונפוץ מאוד אצל בנקים/חברות אשראי בישראל - הקובץ הוא בפועל <html><table>...</table></html> רגיל
// (בדרך כלל עם תגית <x:ExcelWorkbook> ל"רמז" ל-Excel), לא ZIP (xlsx אמיתי) ולא בינארי (xls ישן,
// פורמט BIFF). Excel יודע לפתוח קובץ כזה בלי בעיה כי הוא מזהה תוכן לפי החתימה בפועל, לא לפי
// הסיומת - אבל xlsxParser.js (שמצפה ל-ZIP אמיתי) ייכשל עליו לגמרי. ר' routes/importTransactions.js
// שמזהה אוטומטית איזה משלושת הפרסרים (xlsx/html/csv) להפעיל, לפי תוכן הקובץ בפועל (לא הסיומת).
"use strict";

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/gi, "&");
}

function stripTags(html) {
  return decodeHtmlEntities(String(html).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

// בודקים את תחילת הקובץ (אחרי BOM אם יש) - מספיק כדי להבדיל בבטחון בין טבלת HTML לבין ZIP אמיתי
// (xlsx, שמתחיל תמיד בבתים "PK") או טקסט CSV רגיל (שלא מתחיל בתגית HTML/טבלה בכלל).
function looksLikeHtml(buffer) {
  const head = buffer.subarray(0, 2000).toString("utf8").replace(/^﻿/, "").trimStart();
  return /^<html/i.test(head) || /^<table/i.test(head) || /^<!doctype html/i.test(head);
}

// מוודאים שלא מדובר בקובץ .xls ישן-אמיתי (בינארי, פורמט OLE/BIFF) - זה לא נתמך (אין לו שום קשר
// למבנה ZIP/XML או HTML), אז עדיף להחזיר הודעת שגיאה ברורה וממוקדת במקום כישלון פענוח מוזר.
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
function looksLikeLegacyBinaryXls(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(OLE_SIGNATURE);
}

function parseHtmlTable(html) {
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRegex.exec(html))) {
    const cells = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = cellRegex.exec(rm[1]))) {
      cells.push(stripTags(cm[1]));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

module.exports = { looksLikeHtml, looksLikeLegacyBinaryXls, parseHtmlTable, stripTags };
