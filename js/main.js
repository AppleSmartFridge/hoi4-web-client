import { loadMap, MissingData, borderField, LAND, LAKE } from "./mapdata.js";
import { httpSource, linkSource, NoHostData } from "./mapsource.js";
import { MapRenderer } from "./renderer.js";
import { Camera, Controls } from "./camera.js";
import { Labels } from "./labels.js";
import { Link } from "./link.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

async function main() {
  // --- Live game link ---------------------------------------------------------------
  const link = new Link();
  // hoi4link listens on 127.0.0.1 and Tailscale addresses: a friend's page from the host's
  // Tailscale address connects back to that address. A page hosted elsewhere (GitHub Pages)
  // defaults to the game on this PC; friends enter the host's wss:// address.
  const h = location.hostname;
  const tailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
  const defaultUrl = `ws://${tailnet ? h : "127.0.0.1"}:8787`;
  $("wsUrl").value = store.get("hl.app.url") || defaultUrl;
  const savedToken = store.get("hl.app.token");
  if (savedToken) { $("wsToken").value = savedToken; $("wsRemember").checked = true; }
  $("linkChip").onclick = () => ($("connect").hidden = !$("connect").hidden);
  $("wsClose").onclick = () => ($("connect").hidden = true);
  $("wsStop").onclick = () => link.disconnect();
  const go = () => {
    const url = $("wsUrl").value.trim(), token = $("wsToken").value.trim();
    if (!token) { showError("Enter the token."); return; }
    store.set("hl.app.url", url);
    store.set("hl.app.token", $("wsRemember").checked ? token : null);
    link.connect(url, token);
  };
  $("wsGo").onclick = go;
  $("wsToken").onkeydown = (e) => { if (e.key === "Enter") go(); };
  function showError(t) { $("connectError").textContent = t; $("connectError").hidden = !t; }
  let flewHome = false;
  link.addEventListener("status", (e) => {
    const { status, detail } = e.detail;
    const chip = $("linkChip");
    chip.className = "chip " + ({ connected: "ok", connecting: "warn", error: "bad" }[status] || "");
    const label = { connected: "Live", connecting: "Connecting…", error: "Not connected", disconnected: "Offline · 1936 borders" }[status];
    $("linkText").textContent = status === "connected" && link.state?.country?.tag ? `Live · ${link.state.country.tag}` : label;
    showError(status === "error" ? detail : "");
    if (status === "connected") $("connect").hidden = true;
  });

  // --- Map data: next to the page, or else from the game over the link -------------
  const progress = (t) => ($("loadingText").textContent = t);
  let map;
  try {
    map = await loadMap(httpSource(new URL("data/", location.href).href), progress);
  } catch (e) {
    if (!(e instanceof MissingData)) { fail(e); return; }
    try {
      map = await mapFromGame(link, progress);
    } catch (e2) {
      fail(e2);
      return;
    }
  }

  const stage = $("stage"), mapCanvas = $("map"), labelCanvas = $("labels");
  let renderer;
  try { renderer = new MapRenderer(mapCanvas, map, borderField); } catch (e) { fail(e); return; }
  const labels = new Labels(labelCanvas, map);
  labels.font.onready = () => { dirty = true; };
  const cam = new Camera(map.width, map.height);
  let dirty = true;
  let dpr = 1;
  let hover = null;      // {province, state, owner, x, y}
  let selected = null;   // state id

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = stage.clientWidth, h = stage.clientHeight;
    for (const c of [mapCanvas, labelCanvas]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    cam.resize(w, h);
    dirty = true;
  }
  window.addEventListener("resize", resize);
  resize();

  // Start over Europe, a bit zoomed in, like a new game's camera.
  const home = () => {
    const tag = link.state?.country?.tag;
    const pick = map.countryLabels().filter((l) => l.country.tag === (typeof tag === "string" ? tag : "GER"))
      .sort((a, b) => b.area - a.area)[0];
    if (pick) cam.flyTo(pick.x, pick.y, Math.max(cam.minZoom, 1.1));
    else cam.flyTo(map.width / 2, map.height / 2, cam.minZoom * 2);
    dirty = true;
  };

  // --- Hover and selection (UI only) -------------------------------------------------
  const tooltip = $("tooltip");
  function pick(p) {
    if (!p) return null;
    const m = cam.toMap(p.x, p.y);
    const province = map.provinceAt(m.x, m.y);
    if (!province) return null;
    const stateId = map.stateOf[province];
    return { province, state: stateId ? map.states.get(stateId) : null, owner: map.ownerOfProvince(province), type: map.type[province] };
  }
  function showTooltip(p, h) {
    if (!h || controls.drag) { tooltip.hidden = true; return; }
    let html;
    if (h.type === LAND) {
      const owner = h.owner ? `<span class="sw" style="background:${rgb(h.owner.color)}"></span>${esc(h.owner.name)}` : "Unowned";
      html = `<b>${esc(h.state ? h.state.name : "Province")}</b><br>${owner}<br><span class="sub">Province ${h.province}${h.state ? ` · state ${h.state.id}` : ""}</span>`;
    } else {
      html = `<b>${h.type === LAKE ? "Lake" : "Sea"}</b><br><span class="sub">Province ${h.province}</span>`;
    }
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();
    const x = Math.min(p.x + 16, window.innerWidth - r.width - 8), y = Math.min(p.y + 18, window.innerHeight - r.height - 8);
    tooltip.style.transform = `translate(${x}px, ${y}px)`;
  }
  function setHover(p) {
    hover = pick(p);
    const hs = hover && hover.type === LAND && hover.state ? hover.state.id : -1;
    const hp = hover ? hover.province : -1;
    if (hs !== renderer.hoverState || hp !== renderer.hoverProv) {
      renderer.hoverState = hs;
      renderer.hoverProv = hp;
      dirty = true;
    }
    showTooltip(p, hover);
  }
  function select(stateId) {
    selected = stateId;
    renderer.selState = stateId ?? -1;
    renderStatePanel();
    dirty = true;
  }
  function renderStatePanel() {
    const s = selected != null ? map.states.get(selected) : null;
    $("statePanel").hidden = !s;
    if (!s) return;
    const owner = s.owner ? map.countries.get(s.owner) : null;
    $("stateName").textContent = s.name;
    $("stateSwatch").style.background = owner ? rgb(owner.color) : "#777";
    const land = s.provinces.filter((p) => map.type[p] === LAND).length;
    const facts = [
      ["Owner", owner ? `${owner.name} (${owner.tag})` : "None"],
      ["State", `#${s.id}${s.category ? ` · ${s.category.replace(/_/g, " ")}` : ""}`],
      ["Provinces", land],
    ];
    if (s.impassable) facts.push(["Terrain", "Impassable"]);
    if (s.startOwner && s.startOwner !== s.owner) facts.push(["In 1936", map.countries.get(s.startOwner)?.name || s.startOwner]);
    $("stateFacts").innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  }
  $("stateClose").onclick = () => select(null);

  const controls = new Controls(stage, cam, {
    onHover: (p) => setHover(p),
    onClick: (p) => {
      const h = pick(p);
      select(h && h.type === LAND && h.state ? (h.state.id === selected ? null : h.state.id) : null);
    },
    onChange: () => { dirty = true; },
  });

  // --- Map controls UI --------------------------------------------------------------
  const centre = () => [cam.view.w / 2, cam.view.h / 2];
  $("zoomIn").onclick = () => { cam.zoomAt(1.6, ...centre()); dirty = true; };
  $("zoomOut").onclick = () => { cam.zoomAt(1 / 1.6, ...centre()); dirty = true; };
  $("home").onclick = home;
  window.addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("input")) return;
    if (e.key === "Home") home();
    if (e.key === "Escape") { select(null); $("settings").hidden = true; $("connect").hidden = true; }
  });
  $("settingsBtn").onclick = () => ($("settings").hidden = !$("settings").hidden);
  const opt = (id, key, apply) => {
    const el = $(id), saved = store.get("hl.app." + key);
    if (saved != null) el.type === "range" ? (el.value = saved) : (el.checked = saved === "1");
    const run = () => { apply(el.type === "range" ? Number(el.value) : el.checked); dirty = true; };
    el.oninput = () => { store.set("hl.app." + key, el.type === "range" ? el.value : el.checked ? "1" : "0"); run(); };
    run();
  };
  opt("optCountryNames", "countryNames", (v) => (labels.showCountries = v));
  opt("optStateNames", "stateNames", (v) => (labels.showStates = v));
  opt("optEdge", "edge", (v) => (controls.edgeScroll = v));
  opt("optSmooth", "smooth", (v) => (cam.smoothing = 0.01 + (v / 100) * 0.16));

  function onState(state, changed) {
    $("date").textContent = state.date ? formatDate(state.date) : "";
    if (state.country?.tag) $("linkText").textContent = `Live · ${state.country.tag}`;
    if (changed.includes("states") && state.states && Array.isArray(state.states.owner)) {
      const owners = new Map();
      state.states.owner.forEach((tag, id) => { if (id > 0) owners.set(id, tag); });
      if (map.setOwners(owners)) { dirty = true; renderStatePanel(); }
    }
    // Cosmetic tags and ruling ideologies: names and colours as the game shows them.
    if (changed.includes("countries") && state.countries && typeof state.countries === "object") {
      if (map.setLooks(state.countries)) { dirty = true; renderStatePanel(); }
    }
    // The game's own country-name layout (glyph by glyph); null falls back to fitted labels.
    if (changed.includes("map_names") && labels.setGameNames(state.map_names)) dirty = true;
    if (!flewHome && state.country?.tag) { flewHome = true; home(); }
  }
  link.addEventListener("state", (e) => onState(e.detail.state, e.detail.changed));
  if (Object.keys(link.state).length) onState(link.state, Object.keys(link.state));  // arrived while the map loaded
  else if (savedToken && link.status === "disconnected") link.connect($("wsUrl").value.trim(), savedToken);

  // --- Frame loop -------------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));  // the first frame can be stamped before `last`
    last = now;
    const keys = controls.tick(dt);
    const moving = cam.update(dt);
    if (keys || moving || dirty) {
      renderer.draw(cam, dpr);
      labels.draw(cam, dpr);
      if (moving && controls.pointer && !controls.drag) setHover(controls.pointer);
      dirty = false;
    }
    requestAnimationFrame(frame);
  }
  home();
  cam.x = cam.tx; cam.y = cam.ty; cam.zoom = cam.tz * 0.6;  // ease in on load
  requestAnimationFrame(frame);
  $("loading").classList.add("done");
  window.hl = { map, cam, renderer, labels, link, select };  // for debugging in the console
}

// A hosted page has no data/ folder: wait for the connection, then the game sends the map.
async function mapFromGame(link, progress) {
  if (link.status !== "connected") {
    progress("Connect to your game to load the map. It comes from the game's own files over the connection.");
    $("loading").classList.add("waiting");
    $("connect").hidden = false;
    if (link.status === "disconnected" && $("wsToken").value.trim()) $("wsGo").click();
    await link.whenConnected();
    $("loading").classList.remove("waiting");
  }
  if (!link.server?.map_files) throw new HostError("This game's hoi4link is too old to send the map. Update hoi4link on the game's PC.");
  try {
    return await loadMap(await linkSource(link, progress), progress);
  } catch (e) {
    if (e instanceof NoHostData) throw new HostError("The game's PC has no map data yet.", true);
    throw e;
  }
}

class HostError extends Error {
  constructor(message, build = false) { super(message); this.build = build; }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function formatDate(d) {
  const [y, m, day, h] = d.split(".").map(Number);
  return `${String(h ?? 0).padStart(2, "0")}:00, ${day} ${MONTHS[(m || 1) - 1]} ${y}`;
}

function fail(e) {
  const box = $("loading");
  box.classList.add("failed");
  if (e instanceof HostError) {
    $("loadingText").innerHTML = esc(e.message) + (e.build ? ` On that PC, run
      <pre>python tools/mapgen/build_map.py</pre>It builds the map from that PC's own HOI4 files and copies it to <code>hoi4link\\mapdata</code>, where the game sends it from. Then reload this page.` : "");
  } else if (e instanceof MissingData) {
    $("loadingText").innerHTML = `The map data isn't built yet. It's made from your own HOI4 files and stays on your PC:
      <pre>python tools/mapgen/build_map.py</pre>Then reload this page. <span style="opacity:.7">(${esc(e.message)})</span>`;
  } else {
    $("loadingText").textContent = "Couldn't start the map: " + (e.message || e);
  }
  console.error(e);
}

main();
