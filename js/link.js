// hoi4link WebSocket client (protocol/README.md): hello with the token, then keeps a
// merged copy of the state from the snapshot and deltas. Reconnects after drops,
// but not after an auth refusal. request() sends one message with an id and resolves
// with the reply; a map_file reply also carries the binary frame that follows it.

export class Link extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.state = {};
    this.status = "disconnected";
    this.wanted = false;
    this.retry = null;
    this.nextId = 1;
    this.pending = new Map();  // id -> {resolve, reject}
    this.binaryWait = [];      // map_file replies waiting for their bytes, in order
  }

  // Resolves once connected (now, or whenever the user connects).
  whenConnected() {
    if (this.status === "connected") return Promise.resolve();
    return new Promise((resolve) => {
      const on = (e) => { if (e.detail.status === "connected") { this.removeEventListener("status", on); resolve(); } };
      this.addEventListener("status", on);
    });
  }

  request(msg) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.status !== "connected")
      return Promise.reject(Object.assign(new Error("not connected"), { code: "closed" }));
    const id = `r${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  failPending(code, message) {
    for (const p of this.pending.values()) p.reject(Object.assign(new Error(message), { code }));
    this.pending.clear();
    this.binaryWait = [];
  }

  reply(m) {
    const p = this.pending.get(m.id);
    if (!p) return false;
    this.pending.delete(m.id);
    if (m.type === "error") p.reject(Object.assign(new Error(m.message || m.code), { code: m.code }));
    else if (m.type === "map_file" && !m.ok) p.reject(Object.assign(new Error(m.message || "map file refused"), { code: "refused" }));
    else if (m.type === "map_file") this.binaryWait.push({ m, p });
    else p.resolve(m);
    return true;
  }

  setStatus(status, detail = "") {
    this.status = status;
    this.dispatchEvent(new CustomEvent("status", { detail: { status, detail } }));
  }

  connect(url, token) {
    this.disconnect();
    this.url = url;
    this.token = token;
    this.wanted = true;
    this.open();
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retry);
    if (this.ws) { const ws = this.ws; this.ws = null; ws.close(); }
    this.failPending("closed", "disconnected");
    this.setStatus("disconnected");
  }

  open() {
    this.setStatus("connecting");
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      // An https page (GitHub Pages) may only open wss://, or ws:// to this PC itself.
      const insecure = location.protocol === "https:" && /^ws:\/\//i.test(this.url) &&
        !/^ws:\/\/(127\.|localhost[:/]|\[::1\])/i.test(this.url);
      this.setStatus("error", insecure
        ? "This page is served over https, so it can reach a game on another PC only at a wss:// address (tailscale serve gives the game's PC one). ws://127.0.0.1 works on the game's own PC."
        : String(e.message || e));
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: this.token, client: "hoi4link web" }));
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const w = this.binaryWait.shift();
        if (w) w.p.resolve({ ...w.m, data: ev.data });
        return;
      }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id != null && this.reply(m)) return;
      if (m.type === "hello") {
        this.server = m;
        this.setStatus("connected");
      } else if (m.type === "snapshot") {
        this.state = m.state || {};
        this.dispatchEvent(new CustomEvent("state", { detail: { state: this.state, changed: Object.keys(this.state) } }));
      } else if (m.type === "delta") {
        Object.assign(this.state, m.state || {});
        this.dispatchEvent(new CustomEvent("state", { detail: { state: this.state, changed: Object.keys(m.state || {}) } }));
      } else if (m.type === "error" && m.code === "unauthorized") {
        this.authFailed = true;
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending("closed", "connection closed");
      const auth = { 4001: "The token was refused.", 4002: "No hello in time.", 4003: "Locked out for a minute after bad tokens." }[ev.code];
      if (auth || this.authFailed) {
        this.authFailed = false;
        this.wanted = false;
        this.setStatus("error", auth || "The token was refused.");
        return;
      }
      if (this.wanted) {
        this.setStatus("connecting", "Lost the connection; retrying…");
        this.retry = setTimeout(() => this.open(), 3000);
      } else this.setStatus("disconnected");
    };
    ws.onerror = () => {};
  }
}
