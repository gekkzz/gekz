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

/* ---- MEGA catch-up + saved copy ----
   A shared folder's listing can come back as a saved snapshot. MEGA's own site then asks for every change made
   since (the "sc" feed, starting from the snapshot's sequence number "sn"); megajs doesn't, so files added or
   replaced after the snapshot stay invisible. megaLoadLive() gets the listing, catches up on the changes, and lets
   megajs itself decode the result (no crypto here). The caught-up listing (still encrypted, as MEGA sent it) is
   also kept in this browser (IndexedDB), so the next visit only fetches what changed since.
   Any failure along the way falls back to a plain fresh listing. */
const MEGA_RAW = {}, MEGA_CACHE_DAYS = 14;
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
/* tiny key-value store in IndexedDB; every call quietly does nothing if storage isn't available */
function kvOpen(){ return new Promise((res, rej) => { if (!self.indexedDB) return rej(new Error("no IndexedDB")); const r = indexedDB.open("rr-cache", 1);
  r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("kv")) r.result.createObjectStore("kv"); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("blocked")); }); }
async function kvDo(mode, fn){ try { const db = await kvOpen(); return await new Promise(res => { const tx = db.transaction("kv", mode), st = tx.objectStore("kv"); let out; const q = fn(st); if (q) q.onsuccess = () => { out = q.result; };
  tx.oncomplete = () => { db.close(); res(out); }; tx.onerror = tx.onabort = () => { db.close(); res(undefined); }; }); } catch (_) { return undefined; } }
const kvGet = k => kvDo("readonly", st => st.get(k));
const kvSet = (k, v) => kvDo("readwrite", st => { st.put(v, k); });
const kvDel = k => kvDo("readwrite", st => { st.delete(k); });
async function megaCatchUp(gw, rootHandle, nodes, sn){
  let ok = false, changes = 0;
  nodes = nodes.slice();
  for (let round = 0; round < 25; round++){
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
    let j;
    try { j = await (await fetch(gw + "sc?" + new URLSearchParams({ sn, ssl: 1, n: rootHandle }), { method: "POST", signal: ctl.signal })).json(); }
    catch (_) { break; }
    finally { clearTimeout(timer); }
    if (Array.isArray(j)) j = j[0];
    if (!j || typeof j !== "object") break;                   /* an error code (e.g. the snapshot is too old) */
    ok = true;
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
    if (j.w || !acts.length || !j.sn) break;                   /* "w" = caught up */
  }
  return { ok, nodes, sn, changes };
}
/* decode a listing with megajs: the same listing request, answered with the given (still encrypted) list */
async function megaBuild(makeFile, resp){
  const g = makeFile(), realApi = g.api;
  g.api = Object.create(realApi);
  g.api.request = (req, cb, ...rest) => (req && req.a === "f" && typeof cb === "function") ? cb(null, resp) : realApi.request(req, cb, ...rest);
  try { await g.loadAttributes(); } finally { g.api = realApi; }
  return g;
}
async function megaLoadLive(makeFile, rootHandle, fresh = false){
  const ck = "mega:" + rootHandle;
  const gwOf = f => (f && f.api && f.api.gateway) || "https://g.api.mega.co.nz/";
  if (!fresh){
    const c = await kvGet(ck);
    if (c && Array.isArray(c.f) && c.sn && Date.now() - (c.at || 0) < MEGA_CACHE_DAYS * 864e5){
      try {
        const r = await megaCatchUp(gwOf(megaLive(makeFile())), rootHandle, c.f, c.sn);
        if (r.ok){
          const merged = { f: r.nodes, sn: r.sn }, g = await megaBuild(makeFile, merged);
          g.__caughtUp = r.changes; g.__fromCache = true;
          MEGA_RAW[rootHandle] = merged; kvSet(ck, { f: r.nodes, sn: r.sn, at: Date.now() });
          return g;
        }
      } catch (_) {}
      kvDel(ck);                                                  /* unusable: start over with a fresh listing */
    }
  }
  const f = megaLive(makeFile());
  await f.loadAttributes();
  f.__caughtUp = 0;
  const raw = MEGA_RAW[rootHandle];
  if (!raw || !raw.sn) return f;
  try {
    const r = await megaCatchUp(gwOf(f), rootHandle, raw.f, raw.sn);
    if (r.changes){
      const merged = { f: r.nodes, sn: r.sn }, g = await megaBuild(makeFile, merged);
      g.__caughtUp = r.changes; MEGA_RAW[rootHandle] = merged; kvSet(ck, { f: r.nodes, sn: r.sn, at: Date.now() });
      return g;
    }
    kvSet(ck, { f: raw.f, sn: r.ok ? r.sn : raw.sn, at: Date.now() });
    return f;
  } catch (_) { return f; }
}
const roots = {}, rootAt = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
function rootOf(root, key, fresh = false){
  const k = root + "#" + key;
  if (fresh && roots[k] && Date.now() - (rootAt[k] || 0) > 1500) delete roots[k];   /* requests arriving together share one re-read */
  if (!roots[k]){
    rootAt[k] = Date.now();
    roots[k] = megaLoadLive(() => self.mega.File.fromURL("https://mega.nz/folder/" + root + "#" + key), root, fresh).catch(e => { delete roots[k]; throw e; });
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
    try { file = find(await rootOf(root, key, tries > 0), id); } catch (e) { err = e; }
    if (file) return file;
    if (tries++ >= 2){ if (err) throw err; return null; }
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

/* ---- disk cache: video pieces already downloaded are kept in this browser (IndexedDB), so re-watching after a
   reload or in a new tab doesn't download them from MEGA again. Capped (about 1.5 GB, or half of what the browser
   allows, whichever is less), oldest-used dropped first, and anything unused for 2 weeks is removed. MEGA file IDs
   never change content (a replaced video gets a new ID), so a saved piece is always right. Any storage problem just
   means pieces come from MEGA as before. */
const DISK_CAP = self.RR_DISK_CAP || 1536 * BLOCK, DISK_DAYS = 14;
let disk = null, diskP = null;
const idbReq = q => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
function diskOpen(){
  if (!diskP) diskP = (async () => {
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open("rr-video", 1);
        r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains("b")) d.createObjectStore("b"); if (!d.objectStoreNames.contains("m")) d.createObjectStore("m"); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("blocked")); });
      const meta = new Map(), stale = [], cut = Date.now() - DISK_DAYS * 864e5; let total = 0;
      await new Promise(res => { const tx = db.transaction("m"); tx.objectStore("m").openCursor().onsuccess = e => { const c = e.target.result; if (!c) return;
        const v = c.value; if (v && v.at > cut && v.size > 0){ meta.set(c.key, v); total += v.size; } else stale.push(c.key); c.continue(); }; tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
      let cap = DISK_CAP;
      try { const est = await navigator.storage.estimate(); if (est && est.quota) cap = Math.min(cap, Math.floor(est.quota * 0.5)); } catch (_) {}
      disk = { db, meta, total, cap, touched: new Set(), timer: 0 };
      diskDelete(stale);
      if (disk.total > disk.cap) diskEvict();
    } catch (_) { disk = null; }
    return disk;
  })();
  return diskP;
}
const diskHas = k => !!(disk && disk.meta.has(k));
async function diskGet(k){
  if (!diskHas(k)) return null;
  try {
    const v = await idbReq(disk.db.transaction("b").objectStore("b").get(k));
    if (!v){ const m = disk.meta.get(k); if (m){ disk.meta.delete(k); disk.total -= m.size; } return null; }
    const m = disk.meta.get(k); if (m){ m.at = Date.now(); disk.touched.add(k); if (!disk.timer) disk.timer = setTimeout(diskFlushTouched, 5000); }
    return new Uint8Array(v);
  } catch (_) { return null; }
}
function diskFlushTouched(){
  if (!disk) return; disk.timer = 0;
  const keys = [...disk.touched]; disk.touched.clear();
  try { const tx = disk.db.transaction("m", "readwrite"), st = tx.objectStore("m"); keys.forEach(k => { const m = disk.meta.get(k); if (m) st.put(m, k); }); } catch (_) {}
}
function diskPut(k, bytes){
  if (!disk || disk.meta.has(k) || !bytes || !bytes.byteLength) return;
  const m = { at: Date.now(), size: bytes.byteLength };
  disk.meta.set(k, m); disk.total += m.size;
  try {
    const tx = disk.db.transaction(["b", "m"], "readwrite");
    tx.objectStore("b").put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), k);
    tx.objectStore("m").put(m, k);
    tx.onabort = tx.onerror = () => {                                      /* e.g. storage full: forget it and shrink the cap */
      if (disk.meta.get(k) === m){ disk.meta.delete(k); disk.total -= m.size; }
      disk.cap = Math.max(64 * BLOCK, Math.floor(disk.total * 0.8)); diskEvict();
    };
  } catch (_) { disk.meta.delete(k); disk.total -= m.size; return; }
  if (disk.total > disk.cap) diskEvict();
}
function diskEvict(){
  if (!disk) return;
  const target = disk.cap * 0.85, gone = [];
  for (const [k, m] of [...disk.meta.entries()].sort((a, b) => a[1].at - b[1].at)){ if (disk.total <= target) break; disk.meta.delete(k); disk.total -= m.size; gone.push(k); }
  diskDelete(gone);
}
function diskDelete(keys){
  if (!disk || !keys.length) return;
  try { const tx = disk.db.transaction(["b", "m"], "readwrite"); keys.forEach(k => { tx.objectStore("b").delete(k); tx.objectStore("m").delete(k); }); } catch (_) {}
}
/* pieces being downloaded right now: a second request for the same piece waits for it instead of downloading it twice */
const inflight = new Set();
async function waitBlock(k, job){
  for (let n = 0; n < 200 && !job.cancelled; n++){
    const hit = cget(k); if (hit) return hit;
    if (!inflight.has(k)) return null;
    await sleep(75);
  }
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
    await diskOpen();
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
            let hit = cget(ck(i));
            if (!hit && diskHas(ck(i))){ hit = await diskGet(ck(i)); if (hit) cput(ck(i), hit); }       /* saved earlier: no MEGA download */
            if (!hit && inflight.has(ck(i))) hit = await waitBlock(ck(i), job);                        /* another request is fetching it */
            if (hit){ send(i, hit); i++; continue; }
            if (job.cancelled) break;
            let j = i; while (j + 1 <= b1 && !cache.has(ck(j + 1)) && !diskHas(ck(j + 1)) && !inflight.has(ck(j + 1))) j++;   /* run of missing blocks */
            for (let b = i; b <= j; b++) inflight.add(ck(b));
            /* a dropped MEGA download is retried from the first block not yet sent, so the player never sees the hiccup */
            let next = i;
            try {
              for (let attempt = 0; next <= j; attempt++){
                try { await fetchRun(file, next, j, size, (bi, bytes) => { cput(ck(bi), bytes); diskPut(ck(bi), bytes); inflight.delete(ck(bi)); send(bi, bytes); next = bi + 1; }, job); break; }
                catch (e) { if (job.cancelled || attempt >= 2 || /bandwidth|quota|509|EOVERQUOTA/i.test(String(e && e.message))) throw e; await sleep(500 * (attempt + 1)); }
              }
            } finally { for (let b = i; b <= j; b++) inflight.delete(ck(b)); }
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
