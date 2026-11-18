"use strict";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let state = { servers: [], tasks: [] };
let selected = null;
const logLines = new Map(); // id -> [{t, line}]
const busy = new Set(); // `${id}:${action}` waiting for a response

const STATUS = {
  online: "Online", starting: "Starting", stopping: "Stopping", "game-stopped": "Game stopped",
  failed: "Crashed", offline: "Offline", restarting: "Restarting soon",
};
const ICON = {
  power: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9" /><path d="M6.3 6.3a8 8 0 1 0 11.4 0" /></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>',
  pull: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" /></svg>',
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 6000);
}

async function post(path, body = {}) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

async function act(id, action, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  const key = `${id}:${action}`;
  busy.add(key);
  renderDetail();
  try { await post(`/api/servers/${id}/${action}`); }
  catch (err) { toast(err.message); }
  finally { busy.delete(key); renderDetail(); }
}

const nameOf = (s) => (s.main ? "Main checkout" : s.branch ?? (s.detached ? "Detached HEAD" : s.id));
const folderOf = (s) => s.dir.split(/[\\/]/).pop();
const current = () => state.servers.find((s) => s.id === selected);

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ---- sidebar ----

function renderList() {
  setHtml($("#server-list"), state.servers.map((s) => `
    <button type="button" class="server-item" data-id="${esc(s.id)}" ${s.id === selected ? 'aria-current="true"' : ""}
      title="${esc(STATUS[s.status] ?? s.status)}">
      <span class="dot s-${esc(s.status)}" aria-label="${esc(STATUS[s.status] ?? s.status)}"></span>
      <span class="name">${esc(nameOf(s))}</span>
      ${s.players != null && s.status === "online" ? `<span class="players" title="Players online">${s.players}</span>` : ""}
      <span class="sub">${s.ports.slot ? `Slot ${s.ports.slot}` : "Default ports"} · :${s.ports.client}</span>
    </button>`).join("") || `<p class="muted" style="margin:0 10px">No checkouts found.</p>`);

  const online = state.servers.filter((s) => s.status === "online").length;
  $("#summary").innerHTML = `<b>${online}</b> of ${state.servers.length} online`;

  const tasks = state.tasks ?? [];
  $("#activity-wrap").hidden = tasks.length === 0;
  const open = new Set([...document.querySelectorAll(".task[open]")].map((d) => d.dataset.id));
  $("#tasks").innerHTML = tasks.slice(0, 8).map((t) => `
    <details class="task" data-id="${esc(t.id)}" ${open.has(t.id) || t.state === "running" ? "open" : ""}>
      <summary><span class="dot t-${esc(t.state)}" aria-label="${esc(t.state)}"></span><span>${esc(t.title)}</span></summary>
      <pre>${esc(t.lines.join("\n")) || "…"}</pre>
    </details>`).join("");
  for (const pre of document.querySelectorAll(".task[open] pre")) pre.scrollTop = pre.scrollHeight;
}

// ---- selected server ----

function controlsFor(s) {
  const b = (a) => (busy.has(`${s.id}:${a}`) ? "disabled" : "");
  const name = esc(nameOf(s));
  const gameStopped = s.status === "game-stopped" || s.status === "failed";
  if (s.managed) {
    const stopping = s.status === "stopping";
    return `
      <button type="button" class="power" ${stopping ? "disabled" : b("stop")} data-act="stop" data-confirm="Stop ${name}? Online players are saved first.">${ICON.power}${stopping ? "Stopping" : "Stop"}</button>
      <button type="button" class="icon" ${stopping ? "disabled" : b("restart")} data-act="restart" title="Restart" aria-label="Restart">↻</button>
      ${gameStopped ? `<button type="button" ${b("game-start")} data-act="game-start">Start game</button>` : ""}`;
  }
  if (s.external && s.panelUp) {
    return gameStopped
      ? `<button type="button" class="power primary" ${b("game-start")} data-act="game-start">${ICON.power}Start game</button>`
      : `<button type="button" class="power" ${b("game-stop")} data-act="game-stop" data-confirm="Stop the game in ${name}? Online players are saved first.">${ICON.power}Stop game</button>
         <button type="button" class="icon" ${b("game-restart")} data-act="game-restart" title="Restart game" aria-label="Restart game">↻</button>`;
  }
  if (s.external) return "";
  return `<button type="button" class="power primary" ${b("start")} data-act="start">${ICON.power}Start</button>`;
}

function banners(s) {
  const out = [];
  if (s.external) {
    out.push(`<div class="banner info">${s.panelUp
      ? "Started from a terminal. The panel can stop and restart the game, but the process belongs to that terminal."
      : "Running outside the panel without its world config page. Stop it in the terminal it was started from."}</div>`);
  }
  if (s.note) out.push(`<div class="banner ${/^Crashed|Gave up/.test(s.note) ? "error" : "warn"}">${esc(s.note)}</div>`);
  return out.join("");
}

function factsFor(s) {
  const g = s.git;
  const p = s.ports;
  const running = s.managed || s.external;
  const exit = s.lastExit
    ? `${s.lastExit.requested ? "Stopped" : "Exited"} ${new Date(s.lastExit.at).toLocaleTimeString()}${s.lastExit.requested ? "" : ` (${esc(s.lastExit.signal ?? `code ${s.lastExit.code}`)})`}`
    : "—";
  return `
    <div class="facts">
      <section class="fact-card">
        <h2>Runtime</h2>
        <dl>
          <dt>Status</dt><dd><span class="s-${esc(s.status)}">${esc(STATUS[s.status] ?? s.status)}</span></dd>
          <dt>Players</dt><dd>${s.players ?? "—"}</dd>
          <dt>Uptime</dt><dd id="uptime">—</dd>
          <dt>Started by</dt><dd>${s.managed ? `Panel (pid ${s.pid})` : running ? "Terminal" : "—"}</dd>
          <dt>Last exit</dt><dd>${exit}</dd>
        </dl>
      </section>
      <section class="fact-card">
        <h2>Ports</h2>
        <dl>
          <dt>Client</dt><dd class="mono">${p.client}</dd>
          <dt>Game</dt><dd class="mono">${p.game}</dd>
          <dt>World config</dt><dd class="mono">${p.worldAdmin}</dd>
          <dt>Agent MCP</dt><dd class="mono">${p.mcp}</dd>
          <dt>Gateway</dt><dd class="mono">${p.gateway}</dd>
        </dl>
      </section>
      <section class="fact-card">
        <h2>Git</h2>
        ${g ? `
        <dl>
          <dt>Branch</dt><dd class="mono">${esc(g.branch ?? "?")}</dd>
          <dt>Tracking</dt><dd class="mono">${esc(g.upstream ?? "none")}</dd>
          <dt>Sync</dt><dd>${!g.upstream ? "—" : g.ahead || g.behind
            ? `${g.ahead ? `<span class="tag ok">↑ ${g.ahead} ahead</span> ` : ""}${g.behind ? `<span class="tag warn">↓ ${g.behind} behind</span>` : ""}`
            : "Up to date"}</dd>
          <dt>Changes</dt><dd>${g.dirty ? `<span class="tag warn">${g.dirty} uncommitted</span>` : "Clean"}</dd>
        </dl>
        ${g.last ? `<div class="commit"><code>${esc(g.last.hash)}</code> ${esc(g.last.subject)} <span class="muted">· ${esc(g.last.when)}</span></div>` : ""}`
        : `<p class="muted" style="margin:0">Loading…</p>`}
      </section>
    </div>`;
}

// Only touch the DOM when the markup changed, so a click isn't lost to a redraw every poll.
function setHtml(el, html) {
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

function tickUptime() {
  const s = current();
  const el = document.getElementById("uptime");
  if (el) el.textContent = s?.startedAt ? duration(Date.now() - s.startedAt) : "—";
}

function renderDetail() {
  const s = current();
  const el = $("#detail");
  if (!s) { setHtml(el, `<p class="muted">Select a server.</p>`); return; }
  const running = s.managed || s.external;
  const b = (a) => (busy.has(`${s.id}:${a}`) ? "disabled" : "");
  setHtml(el, `
    <div class="detail-head">
      <div class="heading">
        <h1>${esc(nameOf(s))}</h1>
        <div class="where">${esc(s.dir)}${s.ports.slot ? ` · slot ${s.ports.slot}` : ""}</div>
      </div>
      <span class="status s-${esc(s.status)}" role="status">${esc(STATUS[s.status] ?? s.status)}</span>
    </div>
    <div class="controls">
      ${controlsFor(s)}
      ${running ? `<a class="button" href="${esc(s.links.client)}" target="_blank" rel="noopener">${ICON.external}Open client</a>` : ""}
      ${s.links.worldAdmin && s.panelUp ? `<a class="button" href="${esc(s.links.worldAdmin)}" target="_blank" rel="noopener">${ICON.external}World config</a>` : ""}
      <span class="spacer"></span>
      ${s.git?.upstream ? `<button type="button" ${b("pull")} data-act="pull" title="git pull --ff-only">${ICON.pull}Pull${s.git.behind ? ` (${s.git.behind})` : ""}</button>` : ""}
    </div>
    ${banners(s)}
    ${factsFor(s)}
    <div class="settings-row">
      <label class="toggle" title="Start this server whenever the admin panel starts">
        <input type="checkbox" data-flag="autostart" ${s.autostart ? "checked" : ""}><span class="switch" aria-hidden="true"></span>Start with panel</label>
      <label class="toggle" title="After a crash, restart after 5 s, 15 s, 30 s, 1 min, 2 min, 5 min; then give up">
        <input type="checkbox" data-flag="autorestart" ${s.autorestart ? "checked" : ""}><span class="switch" aria-hidden="true"></span>Auto-restart on crash</label>
      <span class="spacer"></span>
      ${s.main ? "" : `<button type="button" class="danger" ${running || b("remove") ? "disabled" : ""} data-act="remove"
        title="${running ? "Stop the server first" : "Runs scripts/wt rm; the branch is kept"}"
        data-confirm="Remove the worktree ${esc(folderOf(s))}? Git refuses if it has uncommitted changes; the branch itself is kept.">${ICON.trash}Remove worktree</button>`}
    </div>`);
  tickUptime();
}

// ---- console ----

function lineClass(line) {
  if (line.startsWith("[admin]")) return "l-admin";
  if (/\b(error|exception|failed|fatal)\b/i.test(line)) return "l-err";
  if (/\bwarn(ing)?\b/i.test(line)) return "l-warn";
  return "";
}
function renderLogs() {
  const body = $("#logs-body");
  if (!selected) { body.innerHTML = ""; return; }
  const filter = $("#logs-filter").value.toLowerCase();
  const all = logLines.get(selected);
  if (!all) { body.innerHTML = `<span class="empty">Loading…</span>`; return; }
  const lines = all.filter((e) => !filter || e.line.toLowerCase().includes(filter));
  const s = current();
  if (lines.length === 0) {
    body.innerHTML = `<span class="empty">${filter ? "No lines match." : s?.external
      ? "This server was started from a terminal; its output is there."
      : "No output yet. Start the server to see its console here."}</span>`;
    return;
  }
  body.innerHTML = lines.slice(-2000).map((e) => `<span class="${lineClass(e.line)}">${esc(e.line)}</span>`).join("\n");
  if ($("#logs-follow").checked) body.scrollTop = body.scrollHeight;
}
async function loadLogs(id) {
  const res = await fetch(`/api/logs?id=${encodeURIComponent(id)}`);
  if (res.ok) logLines.set(id, (await res.json()).lines);
  if (id === selected) renderLogs();
}
$("#logs-filter").oninput = renderLogs;
$("#logs-follow").onchange = renderLogs;
let logQueued = false;

// ---- selection ----

function select(id) {
  if (!state.servers.some((s) => s.id === id)) id = state.servers[0]?.id ?? null;
  const changed = id !== selected;
  selected = id;
  if (id) store.set("tsps-admin:selected", id);
  if (id && location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
  renderList();
  renderDetail();
  if (changed) {
    $("#logs-filter").value = "";
    renderLogs();
    if (id) loadLogs(id);
  }
  closeMenu();
}

function closeMenu() {
  $("#sidebar").classList.remove("open");
  $("#menu-backdrop").hidden = true;
  $("#menu-toggle").setAttribute("aria-expanded", "false");
}
$("#menu-toggle").onclick = () => {
  const open = !$("#sidebar").classList.contains("open");
  $("#sidebar").classList.toggle("open", open);
  $("#menu-backdrop").hidden = !open;
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
};
$("#menu-backdrop").onclick = closeMenu;

// ---- events ----

$("#server-list").addEventListener("click", (e) => {
  const item = e.target.closest(".server-item");
  if (item) select(item.dataset.id);
});
$("#detail").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (btn && selected) act(selected, btn.dataset.act, btn.dataset.confirm);
});
$("#detail").addEventListener("change", (e) => {
  const flag = e.target.dataset?.flag;
  if (flag && selected) post(`/api/servers/${selected}/flags`, { [flag]: e.target.checked }).catch((err) => toast(err.message));
});
$("#fetch").onclick = () => post("/api/git/fetch").catch((err) => toast(err.message));
$("#new").onclick = () => { $("#new-form").reset(); $("#new-dialog").showModal(); };
$("#new-dialog").addEventListener("close", () => {
  if ($("#new-dialog").returnValue !== "ok") return;
  const f = new FormData($("#new-form"));
  post("/api/worktrees", { branch: f.get("branch"), base: f.get("base") }).catch((err) => toast(err.message));
});
window.addEventListener("hashchange", () => select(location.hash.slice(1)));

function connect() {
  const es = new EventSource("/api/events");
  const conn = $("#conn");
  es.onopen = () => { conn.className = "conn live"; conn.textContent = "Live"; };
  es.onerror = () => { conn.className = "conn down"; conn.textContent = "Reconnecting"; };
  es.addEventListener("state", (e) => {
    state = JSON.parse(e.data);
    if (!selected || !current()) select(location.hash.slice(1) || store.get("tsps-admin:selected"));
    else { renderList(); renderDetail(); }
  });
  es.addEventListener("task", (e) => {
    const t = JSON.parse(e.data);
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = t; else state.tasks.unshift(t);
    renderList();
  });
  es.addEventListener("log", (e) => {
    const { id, t, line } = JSON.parse(e.data);
    const arr = logLines.get(id);
    if (!arr) return; // fetched in full when first selected
    arr.push({ t, line });
    if (arr.length > 3000) arr.splice(0, arr.length - 3000);
    if (id === selected && !logQueued) { logQueued = true; requestAnimationFrame(() => { logQueued = false; renderLogs(); }); }
  });
}
connect();
setInterval(tickUptime, 1000);
