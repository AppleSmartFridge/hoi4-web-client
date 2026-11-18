// Where the map data comes from. Served next to the page (web/app/data, when you run the
// client from your own PC), or, on a page hosted elsewhere such as GitHub Pages, from the
// host's game over the hoi4link connection: after the token check, hoi4link sends the files
// from <game>\hoi4link\mapdata. Those are cached in this browser (IndexedDB), keyed by the
// server's hash, so later visits only download files that changed.

import { MissingData } from "./mapdata.js";

export function httpSource(base) {
  return {
    async get(name) {
      const res = await fetch(base + name);
      if (!res.ok) throw new MissingData(`${name}: HTTP ${res.status}`);
      return res.arrayBuffer();
    },
  };
}

export class NoHostData extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1048576).toFixed(1);

export async function linkSource(link, onProgress = () => {}) {
  const info = await retry(link, { type: "map_info" });
  const files = new Map((info.files || []).map((f) => [f.name, f]));
  if (!files.size) throw new NoHostData("no map data on the host");
  cacheKeep([...files.keys()]);
  const total = [...files.values()].reduce((s, f) => s + f.size, 0);
  let done = 0;
  let chain = Promise.resolve();  // one file at a time: stays inside hoi4link's rate limit
  return {
    get(name) {
      const f = files.get(name);
      if (!f) return Promise.reject(new MissingData(`${name} isn't in the host's map data; rebuild it`));
      const p = chain.then(async () => {
        const hit = await cacheGet(name);
        let data;
        if (hit && hit.hash === f.hash) data = hit.data;
        else {
          data = (await retry(link, { type: "map_file", name })).data;
          cachePut(name, f.hash, data);
        }
        done += f.size;
        onProgress(`Loading the map from the game… ${mb(done)} / ${mb(total)} MB`);
        return data;
      });
      chain = p.catch(() => {});
      return p;
    },
  };
}

async function retry(link, msg) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await link.request(msg);
    } catch (e) {
      if (attempt >= 30) throw e;
      if (e.code === "rate_limited") await sleep(400);
      else if (e.code === "closed") await link.whenConnected();
      else throw e;
    }
  }
}

// --- IndexedDB cache (per browser; any failure just means downloading again) ---------
const DB = "hoi4link-map", STORE = "files";
let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  }));
}
async function cacheGet(name) {
  try { return (await tx("readonly", (s) => s.get(name))) || null; } catch { return null; }
}
async function cachePut(name, hash, data) {
  try { await tx("readwrite", (s) => s.put({ hash, data }, name)); } catch { /* private mode, quota */ }
}
async function cacheKeep(names) {
  try {
    const keys = await tx("readonly", (s) => s.getAllKeys());
    const keep = new Set(names);
    const drop = keys.filter((k) => !keep.has(k));
    if (drop.length) await tx("readwrite", (s) => { drop.forEach((k) => s.delete(k)); });
  } catch { /* ignore */ }
}
