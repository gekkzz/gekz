// Password gate for the whole site (Vercel Routing Middleware).
// Every request (pages, scripts, /api/check) needs the sign-in cookie, except the sign-in page itself.
// The password lives in the Vercel Environment Variable APP_PASSWORD, never in this public repo.
import { next } from "@vercel/functions";

const COOKIE = "rr_auth";
const DAYS = 30;

async function tokenFor(pw) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("rubric-reviewer:" + pw));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function cookies(req) {
  const out = {};
  (req.headers.get("cookie") || "").split(/;\s*/).forEach(p => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i)] = p.slice(i + 1); });
  return out;
}
const safePath = p => (typeof p === "string" && p.startsWith("/") && !p.startsWith("//") ? p : "/");
const escH = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function loginPage(nextPath, wrong) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in - Rubric reviewer</title><meta name="robots" content="noindex">
<style>
:root{--bg:#1b1d1f;--panel:#202326;--line:#2c2f33;--fg:#f1f2f3;--mut:#9aa0a6}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--panel:#fff;--line:#dfe1e4;--fg:#1c1e21;--mut:#5f6368}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
form{width:100%;max-width:340px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{margin:0 0 4px;font-size:18px}p{margin:0 0 16px;color:var(--mut);font-size:14px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
input:focus{outline:2px solid #388bfd;outline-offset:1px}
button{margin-top:12px;width:100%;padding:10px;border:2px solid #388bfd;border-radius:8px;background:transparent;color:var(--fg);font:600 15px system-ui,sans-serif;cursor:pointer}
.err{color:#e5534b;font-size:13px;margin-top:10px}
</style></head><body>
<form method="post" action="/__login">
<h1>Rubric reviewer</h1><p>Enter the password to continue.</p>
<input type="password" name="password" autocomplete="current-password" aria-label="Password" autofocus required>
<input type="hidden" name="next" value="${escH(nextPath)}">
<button type="submit">Sign in</button>
${wrong ? '<div class="err" role="alert">Wrong password. Try again.</div>' : ""}
</form></body></html>`;
  return new Response(html, { status: wrong ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export default async function middleware(request) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return new Response("This site is locked: add an APP_PASSWORD Environment Variable in Vercel, then redeploy.", { status: 503, headers: { "Content-Type": "text/plain" } });
  const url = new URL(request.url);
  const want = await tokenFor(pw);

  if (url.pathname === "/__login" && request.method === "POST") {
    let given = "", nextPath = "/";
    try { const f = await request.formData(); given = String(f.get("password") || ""); nextPath = safePath(String(f.get("next") || "/")); } catch (_) {}
    if ((await tokenFor(given)) !== want) return loginPage(nextPath, true);
    return new Response(null, { status: 303, headers: { Location: nextPath,
      "Set-Cookie": `${COOKIE}=${want}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` } });
  }
  if (url.pathname === "/__logout") {
    return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  }
  if (cookies(request)[COOKIE] === want) return next();
  if (url.pathname.startsWith("/api/")) return new Response(JSON.stringify({ error: "Your sign-in expired. Reload the page and sign in again." }), { status: 403, headers: { "Content-Type": "application/json" } });
  /* page visits get the sign-in form; other files (scripts, the service worker) just get refused */
  if (request.method === "GET" && (url.pathname === "/" || /\.html?$/.test(url.pathname) || url.pathname.endsWith("/") || (request.headers.get("accept") || "").includes("text/html")))
    return loginPage(url.pathname + url.search, false);
  return new Response("Sign in first.", { status: 401, headers: { "Content-Type": "text/plain" } });
}
