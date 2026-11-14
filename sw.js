/* Service worker: streams MEGA videos into the app's own player.
   The page asks for /mega-stream/<root>/<key>/<item>/<name>. This worker answers each byte range the
   video element asks for by fetching just that range from MEGA and decrypting it here, the way MEGA's
   own web player works. Nothing passes through any other server.

   Speed-ups:
   - MEGA is read in larger pieces over more parallel connections (DL below).
   - Everything fetched is kept in memory in 1 MB blocks (up to CACHE_MAX), so going back to a spot,
     the buffer-ahead of the visible clip, and the pre-loaded rubric moments are served instantly. */
const MEGA_LIB = self.MEGA_LIB_URL || "https://cdn.jsdelivr.net/npm/megajs@1.3.10/dist/main.browser-umd.js";
const BLOCK = 1024 * 1024;                 /* cache unit */
const CACHE_MAX = 400 * BLOCK;             /* memory used for cached video, oldest dropped first */
const MAX_RESPONSE = 32 * BLOCK;           /* most sent for one request; the player asks again for more */
const OPEN_RESPONSE = 8 * BLOCK;           /* for open-ended requests ("from here on"), so little is wasted when the player jumps */
const DL = { maxConnections: 6, initialChunkSize: BLOCK, chunkSizeIncrement: BLOCK, maxChunkSize: 4 * BLOCK };
let libErr = null;
try { importScripts(MEGA_LIB); } catch (e) { libErr = e; }

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

/* ---- MEGA catch-up ----
   A shared folder's listing can come back as a saved snapshot. MEGA's own site then asks for every change made
   since (the "sc" feed, starting from the snapshot's sequence number "sn"); megajs doesn't, so files added or
   replaced after the snapshot stay invisible. megaLoadLive() reads the listing, asks for the changes since, applies
   additions, deletions and updates to the raw list, and lets megajs itself decode the result (no crypto here).
   Any failure along the way just keeps the plain listing. */
const MEGA_RAW = {};
function megaLive(f){
  const api = f && f.api;
  if (!api || api.__live || typeof api.request !== "function") return f;
  const orig = api.request.bind(api);
  api.request = (req, cb, ...rest) => {
    if (req && req.a === "f"){
      if ("ca" in req){ req = Object.assign({}, req); delete req.ca; }
      const n = req._querystring && req._querystring.n;
      if (n && typeof cb === "function"){ const cb0 = cb; cb = (err, resp, ...more) => { if (!err && resp && Array.isArray(resp.f)) MEGA_RAW[n] = resp; return cb0(err, resp, ...more); }; }
    }
    return orig(req, cb, ...rest);
  };
  api.__live = true;
  return f;
}
async function megaLoadLive(makeFile, rootHandle){
  const f = megaLive(makeFile());
  await f.loadAttributes();
  f.__caughtUp = 0;
  const raw = MEGA_RAW[rootHandle];
  if (!raw || !raw.sn) return f;
  try {
    let nodes = raw.f.slice(), sn = raw.sn, changes = 0;
    const gw = (f.api && f.api.gateway) || "https://g.api.mega.co.nz/";
    for (let round = 0; round < 25; round++){
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
      let j;
      try { j = await (await fetch(gw + "sc?" + new URLSearchParams({ sn, ssl: 1, n: rootHandle }), { method: "POST", signal: ctl.signal })).json(); }
      finally { clearTimeout(timer); }
      if (Array.isArray(j)) j = j[0];
      if (!j || typeof j !== "object") break;                 /* an error code: keep what we have */
      const acts = Array.isArray(j.a) ? j.a : [];
      for (const p of acts){
        if (!p || typeof p !== "object") continue;
        if (p.a === "t" && p.t && Array.isArray(p.t.f)){
          for (const n of p.t.f){ if (n && n.h){ nodes = nodes.filter(x => x.h !== n.h); nodes.push(n); changes++; } }
        } else if (p.a === "d" && p.n){
          const gone = new Set([p.n]);
          for (let grew = true; grew; ){ grew = false; for (const x of nodes) if (!gone.has(x.h) && gone.has(x.p)){ gone.add(x.h); grew = true; } }
          const before = nodes.length; nodes = nodes.filter(x => !gone.has(x.h)); if (nodes.length !== before) changes++;
        } else if (p.a === "u" && p.n){
          const i = nodes.findIndex(x => x.h === p.n);
          if (i >= 0){ const x = Object.assign({}, nodes[i]); if (p.at) x.a = p.at; if (p.k) x.k = p.k; if (p.ts) x.ts = p.ts; nodes[i] = x; changes++; }
        }
      }
      if (j.sn) sn = j.sn;
      if (j.w || !acts.length || !j.sn) break;                 /* "w" = caught up */
    }
    if (!changes) return f;
    /* rebuild: the same listing request, answered with the caught-up list, decoded by megajs as usual */
    const merged = Object.assign({}, raw, { f: nodes, sn });
    const g = makeFile(), realApi = g.api;
    g.api = Object.create(realApi);
    g.api.request = (req, cb, ...rest) => (req && req.a === "f" && typeof cb === "function") ? cb(null, merged) : realApi.request(req, cb, ...rest);
    await g.loadAttributes();
    g.api = realApi;
    g.__caughtUp = changes;
    MEGA_RAW[rootHandle] = merged;
    return g;
  } catch (e) {
    return f;
  }
}
const roots = {}, rootAt = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
function rootOf(root, key){
  const k = root + "#" + key;
  if (!roots[k]){
    rootAt[k] = Date.now();
    roots[k] = megaLoadLive(() => self.mega.File.fromURL("https://mega.nz/folder/" + root + "#" + key), root).catch(e => { delete roots[k]; throw e; });
  }
  return roots[k];
}
/* Find a file in the shared folder. If it seems to be missing, the folder listing we kept may be stale or
   incomplete (MEGA can answer partially when it's busy, e.g. during fast scrubbing), so read the folder again
   and look once more instead of failing for the rest of the session. */
async function nodeFor(root, key, id){
  const k = root + "#" + key;
  let tries = 0;
  for (;;){
    let file = null, err = null;
    try { file = find(await rootOf(root, key), id); } catch (e) { err = e; }
    if (file) return file;
    if (tries++ >= 2){ if (err) throw err; return null; }
    if (Date.now() - (rootAt[k] || 0) > 1500) delete roots[k];   /* requests arriving together share one re-read */
    await sleep(400 * tries);
  }
}
const handleOf = n => n.nodeId || (Array.isArray(n.downloadId) ? n.downloadId[1] : n.downloadId);
function find(node, id){
  if (!node) return null;
  if (handleOf(node) === id) return node;
  for (const c of node.children || []){ const r = find(c, id); if (r) return r; }
  return null;
}

/* ---- block cache (least recently used dropped first) ---- */
const cache = new Map(); let cacheBytes = 0;
function cget(k){ const v = cache.get(k); if (v){ cache.delete(k); cache.set(k, v); } return v; }
function cput(k, v){
  if (cache.has(k)) return;
  cache.set(k, v); cacheBytes += v.byteLength;
  while (cacheBytes > CACHE_MAX && cache.size){ const [k0, v0] = cache.entries().next().value; cache.delete(k0); cacheBytes -= v0.byteLength; }
}

/* download blocks b0..b1 in one MEGA request, handing each complete block to onBlock in order */
function fetchRun(file, b0, b1, size, onBlock, job){
  return new Promise((res, rej) => {
    const start = b0 * BLOCK, end = Math.min(size - 1, (b1 + 1) * BLOCK - 1);
    let ms; try { ms = file.download({ start, end, ...DL }); } catch (e) { rej(e); return; }
    job.ms = ms;
    let parts = [], have = 0, bi = b0;
    const take = n => {
      const out = new Uint8Array(n); let off = 0;
      while (off < n){ const p = parts[0], k = Math.min(p.length, n - off); out.set(p.subarray(0, k), off); off += k; if (k === p.length) parts.shift(); else parts[0] = p.subarray(k); }
      have -= n; return out;
    };
    ms.on("data", d => {
      if (job.cancelled) return;
      parts.push(d instanceof Uint8Array ? d : new Uint8Array(d)); have += d.length;
      while (have >= BLOCK) onBlock(bi++, take(BLOCK));
    });
    ms.on("end", () => { if (have > 0) onBlock(bi++, take(have)); res(); });
    ms.on("error", rej);
    ms.on("close", () => { if (job.cancelled) res(); });
  });
}

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin === self.location.origin && u.pathname.startsWith("/mega-stream/")) e.respondWith(serve(e.request, u));
});

async function serve(req, u){
  try {
    if (libErr || !self.mega) throw new Error("MEGA library didn't load: " + (libErr && libErr.message));
    const [root, key, id] = u.pathname.slice("/mega-stream/".length).split("/").map(decodeURIComponent);
    const file = await nodeFor(root, key, id);
    if (!file || file.directory) return new Response("Not found in the MEGA folder", { status: 404 });
    const size = file.size || 0;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
    let start = m && m[1] ? +m[1] : 0;
    let end = m && m[2] ? +m[2] : size - 1;
    if (m && !m[1] && m[2]){ start = Math.max(0, size - +m[2]); end = size - 1; }   /* "bytes=-N" = last N bytes */
    if (start >= size) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
    end = Math.min(end, size - 1, start + (m && m[2] ? MAX_RESPONSE : OPEN_RESPONSE) - 1);

    const ck = i => root + "/" + id + "/" + i;
    const job = { cancelled: false, ms: null };
    const b0 = Math.floor(start / BLOCK), b1 = Math.floor(end / BLOCK);
    const body = new ReadableStream({
      async start(c){
        const send = (i, bytes) => {
          if (job.cancelled) return;
          const bs = i * BLOCK, from = Math.max(start, bs) - bs, to = Math.min(end, bs + bytes.length - 1) - bs + 1;
          if (to > from) c.enqueue(bytes.slice(from, to));
        };
        try {
          let i = b0;
          while (i <= b1 && !job.cancelled){
            const hit = cget(ck(i));
            if (hit){ send(i, hit); i++; continue; }
            let j = i; while (j + 1 <= b1 && !cache.has(ck(j + 1))) j++;          /* run of missing blocks */
            /* a dropped MEGA download is retried from the first block not yet sent, so the player never sees the hiccup */
            let next = i;
            for (let attempt = 0; next <= j; attempt++){
              try { await fetchRun(file, next, j, size, (bi, bytes) => { cput(ck(bi), bytes); send(bi, bytes); next = bi + 1; }, job); break; }
              catch (e) { if (job.cancelled || attempt >= 2 || /bandwidth|quota|509|EOVERQUOTA/i.test(String(e && e.message))) throw e; await sleep(500 * (attempt + 1)); }
            }
            i = j + 1;
          }
          if (!job.cancelled) c.close();
        } catch (err) { if (!job.cancelled) try { c.error(err); } catch (_) {} }
      },
      cancel(){ job.cancelled = true; try { job.ms && job.ms.destroy(); } catch (_) {} }
    });
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
