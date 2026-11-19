#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Fleet } from "./fleet.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");

function loadConfig() {
  const config = { tspsRepo: resolve(ROOT, "..", "tsps"), port: 47100, bash: null, dataDir: join(ROOT, "data") };
  for (const file of ["config.json", "config.local.json"]) {
    try { Object.assign(config, JSON.parse(readFileSync(join(ROOT, file), "utf8"))); } catch (err) {
      if (err.code !== "ENOENT") throw new Error(`${file}: ${err.message}`);
    }
  }
  if (process.env.TSPS_REPO) config.tspsRepo = process.env.TSPS_REPO;
  if (process.env.ADMIN_PORT) config.port = Number(process.env.ADMIN_PORT);
  config.tspsRepo = resolve(ROOT, config.tspsRepo);
  config.dataDir = resolve(ROOT, config.dataDir);
  config.bash ??= ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find(existsSync) ?? "bash";
  return config;
}

function loadToken(dataDir) {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const file = join(dataDir, "admin.token");
  try {
    const t = readFileSync(file, "utf8").trim();
    if (t.length >= 24) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString("base64url");
  writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

const config = loadConfig();
if (!existsSync(join(config.tspsRepo, "scripts", "wt"))) {
  console.error(`[admin] ${config.tspsRepo} doesn't look like a tsps checkout; set tspsRepo in config.local.json or TSPS_REPO.`);
  process.exit(1);
}
mkdirSync(config.dataDir, { recursive: true });
const TOKEN = loadToken(config.dataDir);
const COOKIE = `tsps_admin_${config.port}`;
const fleet = new Fleet({ repo: config.tspsRepo, dataDir: config.dataDir, bash: config.bash });

// ---- access: loopback listener, token cookie, pinned Host (DNS rebinding), same-origin writes ----

const safeEqual = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`]);
function cookie(req, name) {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}
const authed = (req) => safeEqual(cookie(req, COOKIE), TOKEN) || safeEqual(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1], TOKEN);

function send(res, status, body, headers = {}) {
  const json = typeof body !== "string";
  res.writeHead(status, { "Content-Type": json ? "application/json" : "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 << 10) throw Object.assign(new Error("Body too large"), { status: 413 });
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8",
};

// ---- live updates (server-sent events) ----

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
let stateQueued = false;
fleet.on("state", () => {
  if (stateQueued) return;
  stateQueued = true;
  setTimeout(() => { stateQueued = false; broadcast("state", fleet.state()); }, 100);
});
fleet.on("log", (id, entry) => broadcast("log", { id, ...entry }));
fleet.on("task", (task) => broadcast("task", { ...task, lines: task.lines.slice(-200) }));

// ---- routes ----

const ACTIONS = {
  start: (id) => fleet.start(id),
  stop: (id) => fleet.stop(id),
  restart: (id) => fleet.restart(id),
  "game-start": (id) => fleet.game(id, "start"),
  "game-stop": (id) => fleet.game(id, "stop"),
  "game-restart": (id) => fleet.game(id, "restart"),
  pull: (id) => fleet.pull(id),
  "cancel-update": (id) => fleet.cancelUpdate(id),
  "open-folder": (id) => fleet.openFolder(id),
  remove: (id, body) => fleet.removeWorktree(id, { discard: body.discard === true }),
};

async function handle(req, res) {
  if (!hosts.has(req.headers.host)) return send(res, 403, { error: "Host not allowed" });
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
    if (!safeEqual(url.searchParams.get("token"), TOKEN)) return send(res, 401, "Wrong token.");
    return send(res, 302, "", { Location: "/", "Set-Cookie": `${COOKIE}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
  }
  if (!authed(req)) {
    return send(res, 401, url.pathname.startsWith("/api/") ? { error: "Unauthorized" }
      : `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
         <title>TSPS | Server Admin Panel</title><link rel=icon href="data:,">
         <body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#16171a;color:#e4dfd3;font:14px/1.6 system-ui,sans-serif;padding:16px">
         <div style="max-width:420px;border:1px solid rgba(202,169,94,.26);border-radius:8px;background:#1c1d21;padding:22px 24px">
         <div style="color:#caa95e;font-weight:600;letter-spacing:.08em;margin-bottom:8px">TSPS <span style="color:rgba(202,169,94,.26)">|</span> <span style="color:#c4bfb2;letter-spacing:0;font-weight:400">Server Admin Panel</span></div>
         Open the link the panel printed when it started (it ends in <code>?token=…</code>).
         The token is in <code>data/admin.token</code>.</div></body>`);
  }

  if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^[\w.-]+$/.test(file) || !TYPES[extname(file)]) return send(res, 404, { error: "Not found" });
    try {
      res.writeHead(200, { "Content-Type": TYPES[extname(file)], "Cache-Control": "no-store" });
      return res.end(readFileSync(join(PUBLIC, file)));
    } catch { return send(res, 404, { error: "Not found" }); }
  }

  if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, fleet.state());
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`event: state\ndata: ${JSON.stringify(fleet.state())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/logs") {
    const rec = fleet.get(url.searchParams.get("id"));
    return send(res, 200, { id: rec.id, lines: rec.logs.slice(-Number(url.searchParams.get("n") || 1000)) });
  }

  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.has(origin.replace(/^http:\/\//, ""))) return send(res, 403, { error: "Cross-origin request refused" });
  if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, { error: "Send application/json" });
  const body = await readJson(req);

  let m;
  if ((m = /^\/api\/servers\/([\w-]+)\/([\w-]+)$/.exec(url.pathname))) {
    const [, id, action] = m;
    if (action === "flags") { fleet.setFlags(id, body); return send(res, 200, { ok: true }); }
    if (action === "world-type") return send(res, 200, { ok: true, ...(await fleet.setWorldType(id, String(body.type ?? ""))) });
    const fn = ACTIONS[action];
    if (!fn) return send(res, 404, { error: "Unknown action" });
    fleet.get(id);
    // Stop can take a minute (players are saved first); answer now and let events report progress.
    const work = Promise.resolve().then(() => fn(id, body));
    const result = await Promise.race([work, new Promise((r) => setTimeout(() => r("pending"), 1500))]);
    if (result === "pending") work.catch((err) => console.error(`[admin] ${action} ${id}: ${err.message}`));
    return send(res, 202, { ok: true, task: result?.id ?? null });
  }
  if (url.pathname === "/api/order") { fleet.setOrder(body.ids); return send(res, 200, { ok: true }); }
  if (url.pathname === "/api/git/fetch") return send(res, 202, { ok: true, task: fleet.fetchAll().id });
  if (url.pathname === "/api/tasks/clear") { fleet.clearTasks(); return send(res, 200, { ok: true }); }
  if (url.pathname === "/api/worktrees") {
    const task = await fleet.createWorktree(String(body.branch ?? "").trim(), String(body.base ?? "").trim(), String(body.type ?? "members"));
    return send(res, 202, { ok: true, task: task.id });
  }
  return send(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) send(res, err.status ?? 500, { error: err.message, ...(err.changes ? { changes: err.changes } : {}) });
    else res.end();
  });
});

await fleet.refresh();
server.listen(config.port, "127.0.0.1", async () => {
  console.info(`[admin] managing ${fleet.servers.size} checkouts of ${config.tspsRepo}`);
  console.info(`[admin] open http://localhost:${config.port}/?token=${TOKEN}`);
  fleet.start_polling();
  await fleet.startOnBoot();
});
server.on("error", (err) => {
  console.error(`[admin] ${err.message}`);
  process.exit(1);
});

let quitting = false;
async function quit() {
  if (quitting) return process.exit(1);
  quitting = true;
  console.info("[admin] stopping the servers this panel started (Ctrl+C again to force)...");
  server.close();
  for (const res of clients) res.end();
  await fleet.shutdown();
  process.exit(0);
}
// A failed background job (a stop that times out, a probe) is logged, never fatal: the panel keeps watching.
process.on("unhandledRejection", (err) => console.error("[admin]", err?.message ?? err));
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
process.on("SIGBREAK", quit);
