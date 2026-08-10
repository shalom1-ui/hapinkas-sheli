// router.js — נתב HTTP מינימלי משלנו (במקום Express, כדי לא להזדקק להתקנת חבילות).
// תומך ב: פרמטרים בנתיב (:id), קריאת גוף JSON, CORS, middleware של אימות.
"use strict";

const { URL } = require("url");

class Router {
  constructor() {
    this.routes = []; // { method, pattern: RegExp, keys, handler }
  }

  _register(method, path, handler) {
    const keys = [];
    const pattern = new RegExp(
      "^" +
        path
          .replace(/\/:[a-zA-Z_]+/g, (match) => {
            keys.push(match.slice(2));
            return "/([^/]+)";
          })
          .replace(/\//g, "\\/") +
        "$"
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  get(path, handler) { this._register("GET", path, handler); }
  post(path, handler) { this._register("POST", path, handler); }
  put(path, handler) { this._register("PUT", path, handler); }
  delete(path, handler) { this._register("DELETE", path, handler); }

  async handle(req, res) {
    const parsedUrl = new URL(req.url, "http://localhost");
    const pathname = decodeURIComponent(parsedUrl.pathname);

    // CORS - מאפשר לאזור האישי (frontend) בכל מקור לקרוא ל-API בזמן פיתוח
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const match = this.routes.find(r => r.method === req.method && r.pattern.test(pathname));
    if (!match) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "לא נמצא נתיב מתאים" }));
      return;
    }

    const values = match.pattern.exec(pathname).slice(1);
    const params = {};
    match.keys.forEach((k, i) => { params[k] = values[i]; });
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    let body = {};
    if (["POST", "PUT"].includes(req.method)) {
      body = await readJsonBody(req).catch(() => ({}));
    }

    const ctx = { req, res, params, query, body };

    try {
      await match.handler(ctx);
    } catch (err) {
      console.error("שגיאת שרת:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "שגיאת שרת פנימית" }));
      }
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    // 20MB - מספיק בנוחות למסמך סרוק/PDF מקודד ב-base64 (ר' routes/documents.js), בלי לאפשר גוף בקשה חסר-גבול
    req.on("data", chunk => { data += chunk; if (data.length > 20_000_000) req.destroy(); });
    req.on("end", () => {
      if (!data) return resolve({});
      const contentType = req.headers["content-type"] || "";
      if (contentType.includes("application/json")) {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        // Twilio שולח את פרטי השיחה בפורמט הזה
        resolve(Object.fromEntries(new URLSearchParams(data)));
      } else {
        resolve({ raw: data });
      }
    });
    req.on("error", reject);
  });
}

// עזרי תגובה
function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
function xml(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/xml; charset=utf-8" });
  res.end(body);
}
// תגובת טקסט גולמי (למשל פרוטוקול ה-API של ימות המשיח, שמצפה למחרוזת פשוטה ולא ל-JSON/XML)
function text(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}
// תגובת HTML (למשל הגשת האזור האישי הגרפי - ר' public/app.html)
function html(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}
// תגובה בינארית גולמית (למשל הורדת קובץ שהועלה - ר' routes/documents.js)
function raw(res, status, buffer, { contentType = "application/octet-stream", filename } = {}) {
  const headers = { "Content-Type": contentType, "Content-Length": buffer.length };
  if (filename) headers["Content-Disposition"] = `attachment; filename="${encodeURIComponent(filename)}"`;
  res.writeHead(status, headers);
  res.end(buffer);
}

module.exports = { Router, json, xml, text, raw, html };
