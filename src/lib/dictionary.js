// dictionary.js — "מילון" ניסוחים חופשיים אישי (לכל חונך/מטפל בנפרד), משותף בין
// routes/reports.js (תוכן דיווח, מגמה/סוג-דיווח מותאמים-אישית) ו-routes/students.js (דיווח מעקב על מפגש חונכות).
"use strict";
const db = require("../db");

// שומר/מעדכן ניסוח ב"מילון" האישי של המשתמש (לפי UNIQUE(user_id, kind, text) -
// אם הניסוח כבר קיים, רק מעדכן את מונה השימושים ואת זמן השימוש האחרון, כדי שהניסוחים הנפוצים יעלו למעלה).
function rememberPhrase(userId, kind, text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  db.prepare(
    `INSERT INTO phrase_dictionary (professional_user_id, kind, text) VALUES (?, ?, ?)
     ON CONFLICT(professional_user_id, kind, text)
     DO UPDATE SET use_count = use_count + 1, last_used_at = datetime('now')`
  ).run(userId, kind, trimmed);
}

function getDictionary(userId, kind) {
  const rows = db
    .prepare(
      `SELECT text FROM phrase_dictionary WHERE professional_user_id = ? AND kind = ?
       ORDER BY use_count DESC, last_used_at DESC LIMIT 30`
    )
    .all(userId, kind);
  return rows.map((r) => r.text);
}

module.exports = { rememberPhrase, getDictionary };
