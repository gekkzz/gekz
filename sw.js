/* Service worker: streams MEGA videos into the app's own player.
   The page asks for /mega-stream/<root>/<key>/<item>/<name>. This worker answers each byte range the
   video element asks for by fetching just that range from MEGA and decrypting it here, the way MEGA's
   own web player works. Nothing passes through any other server. */
const MEGA_LIB = self.MEGA_LIB_URL || "https://cdn.jsdelivr.net/npm/megajs@1.3.10/dist/main.browser-umd.js";
const CHUNK = 32 * 1024 * 1024;   /* largest piece sent per request; the player asks again for more */
let libErr = null;
try { importScripts(MEGA_LIB); } catch (e) { libErr = e; }

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

const roots = {};
function rootOf(root, key){
  const k = root + "#" + key;
  if (!roots[k]){
    const f = self.mega.File.fromURL("https://mega.nz/folder/" + root + "#" + key);
    roots[k] = f.loadAttributes().then(() => f).catch(e => { delete roots[k]; throw e; });
  }
  return roots[k];
}
const handleOf = n => n.nodeId || (Array.isArray(n.downloadId) ? n.downloadId[1] : n.downloadId);
function find(node, id){
  if (!node) return null;
  if (handleOf(node) === id) return node;
  for (const c of node.children || []){ const r = find(c, id); if (r) return r; }
  return null;
}

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin === self.location.origin && u.pathname.startsWith("/mega-stream/")) e.respondWith(serve(e.request, u));
});

async function serve(req, u){
  try {
    if (libErr || !self.mega) throw new Error("MEGA library didn't load: " + (libErr && libErr.message));
    const [root, key, id] = u.pathname.slice("/mega-stream/".length).split("/").map(decodeURIComponent);
    const file = find(await rootOf(root, key), id);
    if (!file || file.directory) return new Response("Not found in the MEGA folder", { status: 404 });
    const size = file.size || 0;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
    let start = m && m[1] ? +m[1] : 0;
    let end = m && m[2] ? +m[2] : size - 1;
    if (m && !m[1] && m[2]){ start = Math.max(0, size - +m[2]); end = size - 1; }   /* "bytes=-N" = last N bytes */
    if (start >= size) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
    end = Math.min(end, size - 1, start + CHUNK - 1);
    const ms = file.download({ start, end });
    const body = new ReadableStream({
      start(c){
        ms.on("data", d => { c.enqueue(new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d)); if (c.desiredSize <= 0 && ms.pause) ms.pause(); });
        ms.on("end", () => { try { c.close(); } catch (_) {} });
        ms.on("error", err => { try { c.error(err); } catch (_) {} });
      },
      pull(){ if (ms.resume) ms.resume(); },
      cancel(){ try { ms.destroy(); } catch (_) {} }
    }, { highWaterMark: 4 * 1024 * 1024, size: ch => ch.byteLength });
    return new Response(body, { status: 206, headers: {
      "Content-Type": /\.webm$/i.test(u.pathname) ? "video/webm" : "video/mp4",
      "Content-Length": String(end - start + 1),
      "Content-Range": "bytes " + start + "-" + end + "/" + size,
      "Accept-Ranges": "bytes", "Cache-Control": "no-store" } });
  } catch (err) {
    const msg = String((err && err.message) || err);
    return new Response(msg, { status: /bandwidth|509/i.test(msg) ? 509 : 502, headers: { "Content-Type": "text/plain" } });
  }
}
