// access.js — פונקציות הרשאה משותפות סביב תלמידים (בעלים / איש מקצוע / הורה משויך),
// כדי שגם students.js וגם reports.js ישתמשו באותה לוגיקה בדיוק ולא יסטו זה מזה בטעות.
"use strict";
const db = require("../db");

function isGuardian(studentId, userId) {
  return !!db.prepare("SELECT 1 FROM student_guardians WHERE student_id = ? AND guardian_user_id = ?").get(studentId, userId);
}

function isOwnerOrProfessional(student, userId) {
  if (student.owner_user_id === userId) return true;
  const user = db.prepare("SELECT roles FROM users WHERE id = ?").get(userId);
  if (!user) return false;
  const roles = (user.roles || "").split(",");
  return roles.includes("mentor") || roles.includes("therapist") || roles.includes("supervisor");
}

module.exports = { isGuardian, isOwnerOrProfessional };
