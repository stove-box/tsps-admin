"use strict";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let state = { servers: [], tasks: [] };
let logId = null;
const logLines = new Map(); // id -> [{t, line}]
const busy = new Set(); // `${id}:${action}` waiting for a response

const STATUS_LABEL = {
  online: "Online", starting: "Starting", stopping: "Stopping", "game-stopped": "Game stopped",
  failed: "Crashed", offline: "Offline", restarting: "Restarting soon",
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
  render();
  try { await post(`/api/servers/${id}/${action}`); }
  catch (err) { toast(err.message); }
  finally { busy.delete(key); render(); }
}

const uptime = (since) => {
  if (!since) return "";
  const s = Math.floor((Date.now() - since) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

function card(s) {
  const name = s.main ? "main checkout" : s.branch ?? (s.detached ? "detached HEAD" : s.id);
  const folder = s.dir.split(/[\\/]/).pop();
  const running = s.managed || s.external;
  const b = (action) => busy.has(`${s.id}:${action}`) ? "disabled" : "";
  const g = s.git;
  const gitHtml = g ? `
    <div class="git">
      <span class="mono">${esc(g.branch ?? "?")}</span>
      ${g.upstream ? `<span class="muted mono">→ ${esc(g.upstream)}</span>` : `<span class="tag">no upstream</span>`}
      ${g.ahead ? `<span class="tag">↑${g.ahead}</span>` : ""}
      ${g.behind ? `<span class="tag warn">↓${g.behind} behind</span>` : ""}
      ${g.dirty ? `<span class="tag warn">${g.dirty} changed</span>` : ""}
      ${g.last ? `<span class="subject" title="${esc(g.last.subject)}"><span class="mono">${esc(g.last.hash)}</span> ${esc(g.last.subject)} · ${esc(g.last.when)}</span>` : ""}
    </div>` : `<div class="git muted">git info loading…</div>`;

  let controls;
  if (s.managed) {
    controls = `
      <button ${b("stop")} data-act="stop" data-confirm="Stop ${esc(name)}? Players are saved first.">Stop</button>
      <button ${b("restart")} data-act="restart">Restart</button>
      ${s.status === "game-stopped" || s.status === "failed" ? `<button ${b("game-start")} data-act="game-start">Start game</button>` : ""}`;
  } else if (s.external) {
    controls = s.panelUp ? `
      <span class="muted">Started from a terminal.</span>
      ${s.status === "game-stopped" || s.status === "failed"
        ? `<button ${b("game-start")} data-act="game-start">Start game</button>`
        : `<button ${b("game-stop")} data-act="game-stop" data-confirm="Stop the game in ${esc(name)}?">Stop game</button>
           <button ${b("game-restart")} data-act="game-restart">Restart game</button>`}`
      : `<span class="muted">Running outside the panel without the world config page; stop it in its terminal.</span>`;
  } else {
    controls = `<button class="primary" ${b("start")} data-act="start">Start</button>`;
  }

  return `
  <article class="card" data-id="${esc(s.id)}">
    <div class="card-head">
      <div class="card-title">
        <strong>${esc(name)}</strong>
        <span class="muted">${esc(folder)}${s.ports.slot ? ` · slot ${s.ports.slot}` : ""}</span>
      </div>
      <span class="pill s-${esc(s.status)}">${esc(STATUS_LABEL[s.status] ?? s.status)}</span>
    </div>
    <div class="meta">
      <span>client <b>${s.ports.client}</b></span>
      <span>game <b>${s.ports.game}</b></span>
      <span>MCP <b>${s.ports.mcp}</b></span>
      <span>config <b>${s.ports.worldAdmin}</b></span>
      ${s.players != null ? `<span>players <b>${s.players}</b></span>` : ""}
      ${s.startedAt ? `<span>up <b>${uptime(s.startedAt)}</b></span>` : ""}
    </div>
    ${gitHtml}
    ${s.note ? `<div class="note">${esc(s.note)}</div>` : ""}
    <div class="row">
      ${controls}
      <button class="small" data-logs>Logs</button>
      ${g?.upstream ? `<button class="small" ${b("pull")} data-act="pull" ${g.behind ? "" : 'title="Already up to date with the last fetch"'}>Pull</button>` : ""}
    </div>
    <div class="links">
      ${running ? `<a href="${esc(s.links.client)}" target="_blank" rel="noopener">Open client ↗</a>` : ""}
      ${s.links.worldAdmin && s.panelUp ? `<a href="${esc(s.links.worldAdmin)}" target="_blank" rel="noopener">World config ↗</a>` : ""}
    </div>
    <div class="flags">
      <label class="check" title="Start this server when the admin panel starts"><input type="checkbox" data-flag="autostart" ${s.autostart ? "checked" : ""}> Start with panel</label>
      <label class="check" title="Restart after a crash, backing off from 5 s to 5 min; gives up after 6 crashes in 15 min"><input type="checkbox" data-flag="autorestart" ${s.autorestart ? "checked" : ""}> Auto-restart</label>
      <span class="spacer"></span>
      ${s.main ? "" : `<button class="small danger" ${running || b("remove") ? "disabled" : ""} data-act="remove"
        data-confirm="Remove the worktree ${esc(folder)}? Git refuses if it has uncommitted changes; the branch itself is kept.">Remove</button>`}
    </div>
  </article>`;
}

function render() {
  $("#repo").textContent = state.repo ?? "";
  $("#servers").innerHTML = state.servers.map(card).join("") || `<p class="muted">No worktrees found.</p>`;
  const tasks = state.tasks ?? [];
  $("#tasks-wrap").hidden = tasks.length === 0;
  const open = new Set([...document.querySelectorAll(".task[open]")].map((d) => d.dataset.id));
  $("#tasks").innerHTML = tasks.map((t) => `
    <details class="task" data-id="${esc(t.id)}" ${open.has(t.id) || t.state === "running" ? "open" : ""}>
      <summary><span class="t-${esc(t.state)}">●</span> <span class="mono">${esc(t.title)}</span> <span class="muted">${esc(t.state)}</span></summary>
      <pre>${esc(t.lines.join("\n"))}</pre>
    </details>`).join("");
  for (const pre of document.querySelectorAll(".task[open] pre")) pre.scrollTop = pre.scrollHeight;
}

// ---- logs ----

function lineClass(line) {
  if (line.startsWith("[admin]")) return "l-admin";
  if (/\b(error|exception|failed|fatal)\b/i.test(line)) return "l-err";
  if (/\bwarn(ing)?\b/i.test(line)) return "l-warn";
  return "";
}
function renderLogs() {
  if (!logId) return;
  const filter = $("#logs-filter").value.toLowerCase();
  const lines = (logLines.get(logId) ?? []).filter((e) => !filter || e.line.toLowerCase().includes(filter));
  const body = $("#logs-body");
  body.innerHTML = lines.slice(-2000).map((e) => `<span class="${lineClass(e.line)}">${esc(e.line)}</span>`).join("\n");
  if ($("#logs-follow").checked) body.scrollTop = body.scrollHeight;
}
async function openLogs(id) {
  logId = id;
  const s = state.servers.find((x) => x.id === id);
  $("#logs-title").textContent = `Logs: ${s?.main ? "main checkout" : s?.branch ?? id}`;
  $("#logs").hidden = false;
  const res = await fetch(`/api/logs?id=${encodeURIComponent(id)}`);
  if (res.ok) logLines.set(id, (await res.json()).lines);
  renderLogs();
}
$("#logs-close").onclick = () => { $("#logs").hidden = true; logId = null; };
$("#logs-filter").oninput = renderLogs;
let logQueued = false;

// ---- events ----

document.addEventListener("click", (e) => {
  const cardEl = e.target.closest(".card");
  if (!cardEl) return;
  const id = cardEl.dataset.id;
  const btn = e.target.closest("button");
  if (btn?.dataset.act) act(id, btn.dataset.act, btn.dataset.confirm);
  else if (btn?.hasAttribute("data-logs")) openLogs(id);
});
document.addEventListener("change", (e) => {
  const flag = e.target.dataset?.flag;
  if (!flag) return;
  const id = e.target.closest(".card").dataset.id;
  post(`/api/servers/${id}/flags`, { [flag]: e.target.checked }).catch((err) => toast(err.message));
});
$("#fetch").onclick = () => post("/api/git/fetch").catch((err) => toast(err.message));
$("#new").onclick = () => { $("#new-form").reset(); $("#new-dialog").showModal(); };
$("#new-dialog").addEventListener("close", () => {
  if ($("#new-dialog").returnValue !== "ok") return;
  const f = new FormData($("#new-form"));
  post("/api/worktrees", { branch: f.get("branch"), base: f.get("base") }).catch((err) => toast(err.message));
});

function connect() {
  const es = new EventSource("/api/events");
  es.onopen = () => { $("#conn").className = "conn live"; $("#conn").textContent = "live"; };
  es.onerror = () => { $("#conn").className = "conn down"; $("#conn").textContent = "reconnecting…"; };
  es.addEventListener("state", (e) => { state = JSON.parse(e.data); render(); });
  es.addEventListener("task", (e) => {
    const t = JSON.parse(e.data);
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = t; else state.tasks.unshift(t);
    render();
  });
  es.addEventListener("log", (e) => {
    const { id, t, line } = JSON.parse(e.data);
    if (!logLines.has(id)) return; // fetched in full when first opened
    const arr = logLines.get(id);
    arr.push({ t, line });
    if (arr.length > 3000) arr.splice(0, arr.length - 3000);
    if (id === logId && !logQueued) { logQueued = true; requestAnimationFrame(() => { logQueued = false; renderLogs(); }); }
  });
}
connect();
setInterval(render, 30_000); // keep uptimes fresh
