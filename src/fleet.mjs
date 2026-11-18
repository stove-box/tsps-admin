import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { childEnv, portsFor, worktreeEnv, worldAdminToken } from "./env.mjs";
import { gitInfo, listWorktrees, samePath, stream, validBranchName } from "./git.mjs";
import { applyChanges, availableTypes, changesFor, currentType, merge, readLayers, validate, writeLocal } from "./worldtype.mjs";

const LOG_LINES = 3000;
const POLL_MS = 3000;
const GIT_MS = 30_000;
const STOP_GRACE_MS = 60_000;
// Seconds before the Nth consecutive automatic restart; after the last one the panel gives up.
const BACKOFF = [5, 15, 30, 60, 120, 300];
const CRASH_WINDOW_MS = 15 * 60_000;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** One answer for the UI out of what the panel knows about the process and what the ports say. */
export function deriveStatus({ managed, procState, probe, retryAt }) {
  if (procState === "stopping") return "stopping";
  const phase = probe?.serverStatus;
  if (phase) return { online: "online", starting: "starting", stopping: "stopping", stopped: "game-stopped", failed: "failed" }[phase] ?? phase;
  if (probe?.gameUp) return "online";
  if (managed) return "starting";
  if (retryAt) return "restarting";
  return "offline";
}

function getJson({ port, path, token, method = "GET", timeout = 1500 }) {
  return new Promise((done) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (method === "POST") headers["Content-Type"] = "application/json";
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false, timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { if (body.length < 4 << 20) body += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        done({ status: res.statusCode, json });
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done({ status: 0, json: null }));
    req.end(method === "POST" ? "{}" : undefined);
  });
}

/** POSTs a JSON body to a world settings page. */
function getJsonBody({ port, path, token, body, timeout = 10_000 }) {
  return new Promise((done) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, path, method: "POST", agent: false, timeout,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} done({ status: res.statusCode, json }); });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done({ status: 0, json: null }));
    req.end(data);
  });
}

function killTree(pid) {
  return new Promise((done) => {
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => done());
    else {
      try { process.kill(-pid, "SIGTERM"); } catch {}
      done();
    }
  });
}

/** PIDs listening on any of `ports` (Windows `netstat -ano`, elsewhere `lsof`). */
function listeningPids(ports) {
  const want = new Set(ports.map(String));
  return new Promise((done) => {
    const [cmd, args] = process.platform === "win32" ? ["netstat", ["-ano", "-p", "TCP"]] : ["lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]];
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 << 20 }, (_err, stdout) => {
      const pids = new Set();
      for (const line of String(stdout).split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (process.platform === "win32") {
          if (cols[3] === "LISTENING" && want.has(cols[1]?.split(":").pop())) pids.add(Number(cols[4]));
        } else if (want.has(cols[8]?.split(":").pop())) pids.add(Number(cols[1]));
      }
      pids.delete(process.pid);
      done([...pids].filter((p) => Number.isInteger(p) && p > 4));
    });
  });
}

/** world.json with world.local.json over it: what the world list shows about this world. */
export function worldInfo(dir) {
  let world = {};
  let error = null;
  try {
    const { shipped, local } = readLayers(dir);
    world = merge(shipped, local);
  } catch (err) {
    error = `world.local.json: ${err.message}`;
  }
  const types = availableTypes(dir);
  const type = currentType(world);
  return {
    name: typeof world.name === "string" && world.name ? world.name : "Old School RuneScape",
    description: typeof world.description === "string" ? world.description : "",
    type,
    typeLabel: types.find((t) => t.id === type)?.label ?? type,
    types,
    members: type !== "f2p",
    xp: Number(world.experienceMultiplier) || 1,
    error,
  };
}

const slug = (dir) => basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-");

export class Fleet extends EventEmitter {
  constructor({ repo, dataDir, bash }) {
    super();
    this.repo = resolve(repo);
    this.dataDir = dataDir;
    this.bash = bash;
    this.servers = new Map();
    this.tasks = [];
    this.logDir = join(dataDir, "logs");
    mkdirSync(this.logDir, { recursive: true });
    this.settingsFile = join(dataDir, "settings.json");
    this.settings = { autostart: {}, autorestart: {} };
    try { Object.assign(this.settings, JSON.parse(readFileSync(this.settingsFile, "utf8"))); } catch {}
    this.closing = false;
  }

  saveSettings() {
    writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2) + "\n");
  }

  key(rec) {
    return resolve(rec.dir).replace(/\\/g, "/").toLowerCase();
  }

  // ---- discovery and probing ----

  async refresh() {
    const list = await listWorktrees(this.repo);
    const seen = new Set();
    for (const wt of list) {
      if (wt.prunable || !existsSync(wt.dir)) continue;
      let rec = [...this.servers.values()].find((r) => samePath(r.dir, wt.dir));
      if (!rec) {
        let id = slug(wt.dir);
        while (this.servers.has(id)) id += "-";
        rec = { id, dir: wt.dir, logs: [], proc: null, procState: null, probe: null, git: null, gitAt: 0, crashes: [], retryAt: null, note: null };
        this.servers.set(id, rec);
      }
      rec.main = samePath(wt.dir, this.repo);
      rec.branch = wt.branch;
      rec.detached = wt.detached;
      const env = worktreeEnv(wt.dir);
      rec.ports = portsFor(env);
      rec.token = worldAdminToken(wt.dir, env);
      rec.world = worldInfo(wt.dir);
      seen.add(rec.id);
    }
    for (const [id, rec] of this.servers) if (!seen.has(id) && !rec.proc) this.servers.delete(id);
    await Promise.all([...this.servers.values()].map((rec) => this.probe(rec)));
    const now = Date.now();
    await Promise.all([...this.servers.values()].filter((r) => now - r.gitAt > GIT_MS).map((r) => this.refreshGit(r)));
    this.emit("state");
  }

  async refreshGit(rec) {
    rec.gitAt = Date.now();
    rec.git = await gitInfo(rec.dir).catch(() => null);
  }

  async probe(rec) {
    const [regions, catalog] = await Promise.all([
      getJson({ port: rec.ports.game, path: "/regions", timeout: 600 }),
      rec.token ? getJson({ port: rec.ports.worldAdmin, path: "/api/catalog", token: rec.token }) : { status: 0 },
    ]);
    const prev = rec.probe?.serverStatus;
    rec.probe = {
      gameUp: regions.status === 200 && Array.isArray(regions.json?.regions),
      panelUp: catalog.status === 200,
      serverStatus: catalog.status === 200 ? catalog.json?.serverStatus ?? null : null,
      players: catalog.status === 200 ? catalog.json?.onlinePlayers ?? null : null,
      members: catalog.status === 200 && typeof catalog.json?.membersWorld === "boolean" ? catalog.json.membersWorld : null,
    };
    // The game crashed inside a panel we launched: the process lives, nodemon waits for a file change.
    if (rec.proc && rec.procState !== "stopping" && rec.probe.serverStatus === "failed" && prev !== "failed") {
      this.log(rec, "[admin] game server reported a crash");
      this.crashed(rec, () => this.game(rec.id, "start"));
    }
    if (rec.probe.serverStatus === "online" && rec.note?.startsWith("Crashed;")) {
      rec.note = `Recovered after a crash at ${new Date(rec.crashes.at(-1)).toLocaleTimeString()}`;
    }
    if (rec.probe.serverStatus === "online" && rec.crashes.length && Date.now() - rec.crashes.at(-1) > CRASH_WINDOW_MS) rec.crashes = [];
  }

  start_polling() {
    const tick = async () => {
      if (this.closing) return;
      try { await this.refresh(); } catch (err) { console.error("[admin] refresh:", err.message); }
      this.timer = setTimeout(tick, POLL_MS);
    };
    return tick();
  }

  // ---- logs ----

  log(rec, line) {
    const clean = line.replace(ANSI, "").replace(/\r/g, "");
    const entry = { t: Date.now(), line: clean };
    rec.logs.push(entry);
    if (rec.logs.length > LOG_LINES) rec.logs.splice(0, rec.logs.length - LOG_LINES);
    rec.logFile?.write(new Date(entry.t).toISOString() + " " + clean + "\n");
    this.emit("log", rec.id, entry);
  }

  openLogFile(rec) {
    const file = join(this.logDir, `${rec.id}.log`);
    try { if (existsSync(file)) renameSync(file, file + ".1"); } catch {}
    rec.logFile?.end();
    rec.logFile = createWriteStream(file, { flags: "a" });
  }

  // ---- lifecycle ----

  get(id) {
    const rec = this.servers.get(id);
    if (!rec) throw Object.assign(new Error("Unknown server"), { status: 404 });
    return rec;
  }

  async start(id, { auto = false } = {}) {
    const rec = this.get(id);
    if (rec.proc) return;
    clearTimeout(rec.retryTimer);
    rec.retryAt = null;
    if (!auto) { rec.crashes = []; rec.note = null; }
    if (rec.probe?.gameUp || rec.probe?.panelUp) {
      throw Object.assign(new Error("Already running outside the panel (started from a terminal). Use Game start/stop, or stop it there first."), { status: 409 });
    }
    // An automatic restart keeps appending, so the crash stays in the same file.
    if (!auto || !rec.logFile) this.openLogFile(rec);
    this.log(rec, `[admin] yarn start in ${rec.dir}`);
    // One command string: Node warns about (and won't escape) separate args when shell is on.
    const proc = spawn("yarn start", {
      cwd: rec.dir,
      env: childEnv(process.env, rec.dir),
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    rec.proc = proc;
    rec.procState = "running";
    rec.startedAt = Date.now();
    rec.stopRequested = false;
    for (const s of [proc.stdout, proc.stderr]) {
      let rest = "";
      s.setEncoding("utf8");
      s.on("data", (chunk) => {
        const lines = (rest + chunk).split("\n");
        rest = lines.pop();
        for (const l of lines) this.log(rec, l);
      });
      s.on("end", () => rest && this.log(rec, rest));
    }
    proc.on("error", (err) => this.log(rec, `[admin] could not start: ${err.message}`));
    proc.on("exit", (code, signal) => {
      rec.proc = null;
      rec.procState = null;
      rec.probe = null; // the last poll described the process that just ended
      rec.lastExit = { code, signal, at: Date.now(), requested: rec.stopRequested };
      this.log(rec, `[admin] exited (${signal ?? `code ${code}`})`);
      if (!rec.stopRequested && !this.closing) this.crashed(rec, () => this.start(rec.id, { auto: true }));
      this.emit("state");
      rec.stopResolve?.();
    });
    this.emit("state");
  }

  /** Records a crash and, if auto-restart is on, schedules `again` with backoff. */
  crashed(rec, again) {
    const now = Date.now();
    rec.crashes = rec.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    rec.crashes.push(now);
    if (!this.settings.autorestart[this.key(rec)]) { rec.note = "Crashed"; return; }
    const n = rec.crashes.length - 1;
    if (n >= BACKOFF.length) {
      rec.note = `Gave up after ${rec.crashes.length} crashes in 15 minutes`;
      this.log(rec, `[admin] ${rec.note}`);
      return;
    }
    const delay = BACKOFF[n] * 1000;
    rec.retryAt = now + delay;
    rec.note = `Crashed; restarting in ${BACKOFF[n]} s`;
    this.log(rec, `[admin] auto-restart in ${BACKOFF[n]} s (attempt ${n + 1}/${BACKOFF.length})`);
    clearTimeout(rec.retryTimer);
    rec.retryTimer = setTimeout(() => {
      rec.retryAt = null;
      Promise.resolve(again()).catch((err) => this.log(rec, `[admin] auto-restart failed: ${err.message}`));
    }, delay);
  }

  /** Asks the game to save players and stop, then waits until it reports stopped (or the grace runs out). */
  async saveAndStopGame(rec) {
    if (!rec.token || rec.probe?.serverStatus !== "online") return;
    this.log(rec, "[admin] asking the game to save players and stop");
    await getJson({ port: rec.ports.worldAdmin, path: "/api/server/stop", token: rec.token, method: "POST", timeout: 5000 });
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline) {
      const c = await getJson({ port: rec.ports.worldAdmin, path: "/api/catalog", token: rec.token });
      if (c.status !== 200 || ["stopped", "failed"].includes(c.json?.serverStatus)) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** A world started from a terminal: save players, then end the processes listening on its own ports. */
  async stopExternal(rec) {
    if (rec.procState === "stopping") return;
    rec.procState = "stopping";
    this.emit("state");
    try {
      await this.saveAndStopGame(rec);
      const pids = await listeningPids(Object.values(rec.ports).filter((p) => typeof p === "number"));
      this.log(rec, `[admin] ending terminal-started processes: ${pids.join(", ") || "none left"}`);
      for (const pid of pids) await killTree(pid);
    } finally {
      rec.procState = null;
      rec.probe = null;
      await this.probe(rec).catch(() => {});
      this.emit("state");
    }
  }

  /** Lets the game save players, then ends the whole `yarn start` tree. */
  async stop(id) {
    const rec = this.get(id);
    clearTimeout(rec.retryTimer);
    rec.retryAt = null;
    rec.note = null;
    if (!rec.proc) {
      if (rec.probe?.gameUp || rec.probe?.panelUp) return this.stopExternal(rec);
      return;
    }
    if (rec.procState === "stopping") return;
    rec.stopRequested = true;
    rec.procState = "stopping";
    this.emit("state");
    const exited = new Promise((r) => (rec.stopResolve = r));
    await this.saveAndStopGame(rec);
    if (rec.proc) {
      this.log(rec, "[admin] ending process tree");
      await killTree(rec.proc.pid);
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  }

  async restart(id) {
    const rec = this.get(id);
    if (rec.proc && rec.probe?.serverStatus === "online") return this.game(id, "restart");
    await this.stop(id);
    await this.start(id);
  }

  /** Start/stop/restart the game inside a running panel (also works for terminal-started servers). */
  async game(id, action) {
    const rec = this.get(id);
    if (!["start", "stop", "restart"].includes(action)) throw Object.assign(new Error("Unknown action"), { status: 400 });
    if (!rec.token) throw Object.assign(new Error("No world-admin token for this worktree yet (start it once)."), { status: 409 });
    const r = await getJson({ port: rec.ports.worldAdmin, path: `/api/server/${action}`, token: rec.token, method: "POST", timeout: 5000 });
    if (r.status === 0) throw Object.assign(new Error("The world config page isn't reachable; is the server running with `yarn start`?"), { status: 409 });
    if (r.status >= 400) throw Object.assign(new Error(r.json?.error ?? `HTTP ${r.status}`), { status: 409 });
    this.log(rec, `[admin] game ${action} requested`);
  }

  /**
   * Switches the world type. Online: through the world settings page's Apply, which saves players,
   * writes world.local.json and restarts (with the in-game update countdown when players are on).
   * Not running, or running with the game stopped: world.local.json is written here, for the next start.
   */
  async setWorldType(id, type) {
    const rec = this.get(id);
    const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
    const label = availableTypes(rec.dir).find((t) => t.id === type)?.label;
    if (!label) fail("This world's code doesn't have that world type.", 400);
    const layers = readLayers(rec.dir);
    if (currentType(merge(layers.shipped, layers.local)) === type) return { result: "unchanged" };
    const changes = changesFor(type, layers.shipped);
    const problem = validate(merge(layers.shipped, applyChanges(layers.shipped, layers.local, changes)));
    if (problem) fail(problem, 400);
    const status = rec.probe?.serverStatus;

    if (status === "online") {
      const catalog = await getJson({ port: rec.ports.worldAdmin, path: "/api/catalog", token: rec.token });
      const localHash = catalog.json?.layers?.localHash;
      if (catalog.status !== 200 || typeof localHash !== "string") fail("The world settings page didn't answer; try again.");
      const r = await getJsonBody({ port: rec.ports.worldAdmin, path: "/api/apply", token: rec.token, body: { changes, localHash, seconds: 60 } });
      if (r.status >= 400 || r.status === 0) fail(r.json?.error ?? r.json?.errors?.join("; ") ?? `World settings refused the change (HTTP ${r.status}).`);
      const applied = r.json?.applied;
      this.log(rec, `[admin] world type -> ${label} (${applied})`);
      return {
        result: applied,
        message: applied === "countdown" ? `Players get a ${r.json.seconds}-second update countdown, then World ${300 + (rec.ports.slot ?? 0)} restarts as ${label}.`
          : applied === "restarting" ? `Restarting as ${label}.`
          : `Saved. Restart the world to become ${label}.`,
      };
    }
    if (rec.procState === "stopping" || status === "starting" || status === "stopping" || (rec.proc && !status)) {
      fail("Wait until the world has finished starting or shutting down.");
    }
    if (rec.probe?.gameUp && !rec.probe?.panelUp) fail("This world runs without its settings page; shut it down first.");
    writeLocal(rec.dir, layers, applyChanges(layers.shipped, layers.local, changes));
    rec.world = worldInfo(rec.dir);
    this.log(rec, `[admin] world type -> ${label} (saved for the next launch)`);
    this.emit("state");
    return { result: "written", message: `Saved. World ${300 + (rec.ports.slot ?? 0)} is ${label} from its next launch.` };
  }

  setFlags(id, { autostart, autorestart }) {
    const rec = this.get(id);
    const k = this.key(rec);
    if (typeof autostart === "boolean") this.settings.autostart[k] = autostart;
    if (typeof autorestart === "boolean") this.settings.autorestart[k] = autorestart;
    this.saveSettings();
    this.emit("state");
  }

  async startOnBoot() {
    for (const rec of this.servers.values()) {
      if (!this.settings.autostart[this.key(rec)]) continue;
      if (rec.proc || rec.probe?.gameUp || rec.probe?.panelUp) continue;
      await this.start(rec.id).catch((err) => console.error(`[admin] autostart ${rec.id}: ${err.message}`));
    }
  }

  async shutdown() {
    this.closing = true;
    clearTimeout(this.timer);
    await Promise.all([...this.servers.values()].filter((r) => r.proc).map((r) => this.stop(r.id).catch(() => {})));
  }

  // ---- git and worktrees ----

  task(title, fn) {
    const task = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, state: "running", lines: [], at: Date.now() };
    this.tasks.unshift(task);
    this.tasks.splice(20);
    const onLine = (l) => {
      // git progress redraws one line with \r; keep only its last state.
      task.lines.push(l.split("\r").filter(Boolean).pop()?.replace(ANSI, "") ?? "");
      if (task.lines.length > 500) task.lines.shift();
      this.emit("task", task);
    };
    this.emit("task", task);
    Promise.resolve(fn(onLine))
      .then((code) => { task.state = code === 0 ? "done" : "failed"; })
      .catch((err) => { onLine(err.message); task.state = "failed"; })
      .finally(async () => {
        this.emit("task", task);
        await this.refresh().catch(() => {});
      });
    return task;
  }

  fetchAll() {
    return this.task("git fetch --all --prune", (onLine) => stream("git", ["-C", this.repo, "fetch", "--all", "--prune", "--progress"], { onLine })
      .then((code) => { for (const r of this.servers.values()) r.gitAt = 0; return code; }));
  }

  pull(id) {
    const rec = this.get(id);
    if (!rec.git?.upstream) throw Object.assign(new Error("This branch has no upstream to pull from."), { status: 409 });
    return this.task(`git pull --ff-only (${rec.branch ?? rec.id})`, (onLine) => stream("git", ["-C", rec.dir, "pull", "--ff-only"], { onLine })
      .then((code) => { rec.gitAt = 0; return code; }));
  }

  /**
   * `scripts/wt new <branch> [base]`, then the chosen world type: written into the new worktree's
   * world.local.json (it isn't running yet), so its first launch is already that type.
   */
  async createWorktree(branch, base, type = "members") {
    if (!(await validBranchName(branch))) throw Object.assign(new Error("Not a valid branch name."), { status: 400 });
    if (base && !/^[A-Za-z0-9._\/-]+$/.test(base)) throw Object.assign(new Error("Not a valid base ref."), { status: 400 });
    if (!/^(members|f2p|hardcore|league:\d+)$/.test(type)) throw Object.assign(new Error("Unknown world type."), { status: 400 });
    const args = [join(this.repo, "scripts", "wt"), "new", branch, ...(base ? [base] : [])];
    // Where `wt new` puts it: beside the main checkout, named after it and the branch.
    const dir = join(dirname(this.repo), `${basename(this.repo)}-${branch.replace(/\//g, "-")}`);
    return this.task(`New world: ${branch}`, async (onLine) => {
      const code = await stream(this.bash, args, { cwd: this.repo, env: childEnv(process.env, this.repo), onLine });
      if (code !== 0 || type === "members") return code;
      await this.refresh();
      const rec = [...this.servers.values()].find((r) => samePath(r.dir, dir));
      try {
        if (!rec) throw new Error(`couldn't find the new world at ${dir}`);
        const r = await this.setWorldType(rec.id, type);
        onLine(r.message ?? "World type set.");
      } catch (err) {
        // The world exists; only its type didn't take. Say so and leave it Members.
        onLine(`World type not set (${err.message}); the world is Members. Change it from its World type menu.`);
      }
      return 0;
    });
  }

  /**
   * `scripts/wt rm`. Git refuses a worktree with uncommitted changes; with `discard: true` (the page
   * lists them and asks first) it runs `git worktree remove --force`. The branch is always kept.
   */
  async removeWorktree(id, { discard = false } = {}) {
    const rec = this.get(id);
    if (rec.main) throw Object.assign(new Error("The main checkout can't be removed."), { status: 400 });
    if (rec.proc || rec.probe?.gameUp || rec.probe?.panelUp) throw Object.assign(new Error("Shut the world down first."), { status: 409 });
    await this.refreshGit(rec);
    const dir = rec.dir.replace(/\\/g, "/");
    const name = rec.branch ?? basename(rec.dir);
    if (!rec.git?.dirty) {
      return this.task(`Remove ${name}`, (onLine) => stream(this.bash, [join(this.repo, "scripts", "wt"), "rm", dir], { cwd: this.repo, onLine }));
    }
    if (!discard) {
      throw Object.assign(new Error(`${rec.git.dirty} uncommitted change(s) would be lost.`), { status: 409, changes: rec.git.changes });
    }
    const n = rec.git.dirty;
    return this.task(`Remove ${name} (discarding ${n} change${n === 1 ? "" : "s"})`, async (onLine) => {
      for (const c of rec.git.changes) onLine(`discard ${c}`);
      // The other half of `wt rm`: drop the agent MCP entry if it pointed at this worktree.
      await stream("claude", ["mcp", "remove", "tsps", "-s", "local"], { cwd: rec.dir, onLine: () => {} });
      return stream("git", ["-C", this.repo, "worktree", "remove", "--force", dir], { onLine });
    });
  }

  // ---- view ----

  view(rec) {
    const k = this.key(rec);
    return {
      id: rec.id,
      dir: rec.dir,
      main: rec.main,
      branch: rec.branch,
      detached: rec.detached,
      ports: rec.ports,
      status: deriveStatus(rec.proc ? { managed: true, procState: rec.procState, probe: rec.probe } : { managed: false, probe: rec.probe, retryAt: rec.retryAt }),
      managed: !!rec.proc,
      external: !rec.proc && !!(rec.probe?.gameUp || rec.probe?.panelUp),
      panelUp: !!rec.probe?.panelUp,
      players: rec.probe?.players ?? null,
      pid: rec.proc?.pid ?? null,
      startedAt: rec.proc ? rec.startedAt : null,
      lastExit: rec.lastExit ?? null,
      note: rec.note,
      retryAt: rec.retryAt,
      autostart: !!this.settings.autostart[k],
      autorestart: !!this.settings.autorestart[k],
      world: { ...rec.world, number: 300 + (rec.ports.slot ?? 0) },
      git: rec.git,
      links: {
        client: `http://localhost:${rec.ports.client}`,
        worldAdmin: rec.token ? `http://localhost:${rec.ports.worldAdmin}/?token=${encodeURIComponent(rec.token)}` : null,
        mcp: `http://127.0.0.1:${rec.ports.mcp}/mcp`,
      },
    };
  }

  state() {
    const servers = [...this.servers.values()].map((r) => this.view(r));
    servers.sort((a, b) => (b.main - a.main) || (a.ports.slot ?? 0) - (b.ports.slot ?? 0) || a.id.localeCompare(b.id));
    return { repo: this.repo, servers, tasks: this.tasks.map(({ lines, ...t }) => ({ ...t, lines: lines.slice(-200) })) };
  }
}
