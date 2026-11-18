"use strict";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let state = { servers: [], tasks: [] };
let selected = null;
let chatFilter = "all";
const logLines = new Map(); // id -> [{t, line}]
const busy = new Set(); // `${id}:${action}` waiting for a response

const STATUS = {
  online: "Online", starting: "Starting", stopping: "Shutting down", "game-stopped": "World stopped",
  failed: "Crashed", offline: "Offline", restarting: "Restarting soon",
};
const BUSY = new Set(["starting", "stopping", "restarting"]);

// World list icons, following the game's World Switcher (oldschool.runescape.wiki/w/World): star
// colours mark the world type, using the wiki's sprites: the members star (16x16,
// public/members-world.png), the free-to-play star (public/free-world.png), the members star turned
// green for Leagues, and the Hardcore Worlds icon (13x13, public/hardcore-world.png).
const SPRITE = {
  members: { src: "members-world.png", size: 16, label: "Members" },
  free: { src: "free-world.png", size: 16, label: "Free-to-play" },
  league: { src: "members-world.png", size: 16, label: "League" },
  hardcore: { src: "hardcore-world.png", size: 13, label: "Hardcore World" },
};

function iconKind(world) {
  const league = /^league:(\d+)$/.exec(world.type ?? "");
  if (league) return { kind: "league", n: Number(league[1]) };
  if (world.type === "hardcore") return { kind: "hardcore" };
  return { kind: world.members === false || world.type === "f2p" ? "free" : "members" };
}

function worldIcon(world) {
  const k = iconKind(world);
  const sprite = SPRITE[k.kind];
  const label = k.kind === "league" ? world.typeLabel ?? sprite.label : sprite.label;
  return `<img class="star sprite ${k.kind}" src="${sprite.src}" width="${sprite.size}" height="${sprite.size}" alt="${esc(label)} world" title="${esc(label)}">`;
}

/** The legend under the World Switcher: every icon, so a League or Hardcore world is recognisable on sight. */
const LEGEND = [
  [{ type: "members" }, "Members"],
  [{ type: "f2p", members: false }, "Free"],
  [{ type: "league:0", typeLabel: "League" }, "League"],
  [{ type: "hardcore" }, "Hardcore"],
].map(([world, text]) => `<span class="legend-item">${worldIcon(world)}${text}</span>`).join("");
const ICON = {
  power: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9" /><path d="M6.3 6.3a8 8 0 1 0 11.4 0" /></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>',
  update: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></svg>',
  people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" /></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>',
  crown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" /></svg>',
  xp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19l5-6 4 3 7-9" /><path d="M15 7h5v5" /></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" /></svg>',
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function toast(msg, kind = "error") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 7000);
}

async function post(path, body = {}) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { data: json });
  return json;
}

async function act(id, action, { confirmText, body } = {}) {
  if (confirmText && !confirm(confirmText)) return;
  const key = `${id}:${action}`;
  busy.add(key);
  renderWorld();
  try { await post(`/api/servers/${id}/${action}`, body); }
  catch (err) { toast(err.message); }
  finally { busy.delete(key); renderWorld(); }
}

const current = () => state.servers.find((s) => s.id === selected);
const activityOf = (s) => (s.main ? "main" : s.branch ?? (s.detached ? "detached HEAD" : s.id));
const folderOf = (s) => s.dir.split(/[\\/]/).pop();
const running = (s) => s.managed || s.external;

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Only touch the DOM when the markup changed, so a click isn't lost to a redraw every poll.
function setHtml(el, html) {
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

// ---- World Switcher ----

function renderSwitcher() {
  setHtml($("#world-list"), state.servers.map((s) => {
    const off = s.status === "offline" || s.status === "game-stopped" || s.status === "failed";
    const count = s.status === "online" ? (s.players ?? 0)
      : BUSY.has(s.status) ? "..." : s.status === "failed" ? "CRASH" : "OFF";
    return `
    <button type="button" class="world-row ${off ? "is-offline" : ""} ${BUSY.has(s.status) ? "is-busy" : ""}" data-id="${esc(s.id)}"
      ${s.id === selected ? 'aria-current="true"' : ""} title="World ${s.world.number}: ${esc(STATUS[s.status] ?? s.status)}">
      ${worldIcon(s.world)}
      <span class="num">${s.world.number}</span>
      <span class="count">${count}</span>
      <span class="activity">${esc(activityOf(s))}</span>
    </button>`;
  }).join("") || `<p class="rs" style="margin:6px;color:#e8dcc0">No worlds yet. Create one.</p>`);

  const online = state.servers.filter((s) => s.status === "online");
  const players = online.reduce((n, s) => n + (s.players ?? 0), 0);
  setHtml($("#total"), `<b>${players}</b> players on <b>${online.length}</b> of ${state.servers.length} worlds`);
  setHtml($("#legend"), LEGEND);

  const jobs = state.tasks ?? [];
  $("#jobs-wrap").hidden = jobs.length === 0;
  const open = new Set([...document.querySelectorAll(".job[open]")].map((d) => d.dataset.id));
  setHtml($("#jobs"), jobs.slice(0, 8).map((t) => `
    <details class="job" data-id="${esc(t.id)}" ${open.has(t.id) || t.state === "running" ? "open" : ""}>
      <summary><span class="pip j-${esc(t.state)}" aria-label="${esc(t.state)}"></span><span class="t">${esc(t.title)}</span></summary>
      <pre>${esc(t.lines.join("\n")) || "..."}</pre>
    </details>`).join(""));
  for (const pre of document.querySelectorAll(".job[open] pre")) pre.scrollTop = pre.scrollHeight;
}

// ---- selected world ----

function heroActions(s) {
  const b = (a) => (busy.has(`${s.id}:${a}`) ? "disabled" : "");
  const n = s.world.number;
  const stopping = s.status === "stopping";
  const play = running(s) && s.status === "online"
    ? `<a class="play" href="${esc(s.links.client)}" target="_blank" rel="noopener">Play<small>World ${n}</small></a>`
    : `<span class="play off" aria-disabled="true">Play<small>${esc(STATUS[s.status] ?? s.status)}</small></span>`;

  let power;
  if (running(s)) {
    const confirmText = s.external
      ? `Shut down World ${n}? It was launched from a terminal: online players are saved, then the processes on its ports are ended.`
      : `Shut down World ${n}? Online players are saved first.`;
    power = `<button type="button" class="stone red" ${stopping ? "disabled" : b("stop")} data-act="stop" data-confirm="${esc(confirmText)}">${ICON.power}${stopping ? "Shutting down" : "Shut down"}</button>`;
    if (s.status === "game-stopped" || s.status === "failed") {
      power = `<button type="button" class="stone gold" ${b("game-start")} data-act="game-start">${ICON.power}Start world</button>` + power;
    }
  } else {
    power = `<button type="button" class="stone gold" ${b("start")} data-act="start">${ICON.power}Launch world</button>`;
  }
  const canRestart = running(s) && !stopping && (s.managed || s.panelUp);
  const restart = canRestart
    ? `<button type="button" class="stone icon" ${b(s.managed ? "restart" : "game-restart")} data-act="${s.managed ? "restart" : "game-restart"}" title="Restart server" aria-label="Restart server">${ICON.restart}</button>`
    : "";
  return `${play}<div class="row">${power}${restart}</div>`;
}

function banners(s) {
  const out = [];
  if (s.external) out.push(`<div class="banner info">This world was launched from a terminal, so its console is there. Shut down still saves players first.</div>`);
  if (s.note) out.push(`<div class="banner ${/^Crashed|Gave up/.test(s.note) ? "error" : "warn"}">${esc(s.note)}</div>`);
  return out.join("");
}

function stat(icon, value, label, id) {
  return `<div class="stat osrs"><span class="orb">${icon}</span><div><div class="v"${id ? ` id="${id}"` : ""}>${value}</div><div class="k">${label}</div></div></div>`;
}

/** The World type tile: a dropdown of the types this world's code has. */
function typeTile(s) {
  // A panel process older than world types sends none: show the type without the dropdown.
  if (!s.world.types?.length) return stat(ICON.crown, s.world.members ? "Members" : "Free-to-play", "World type");
  const changing = busy.has(`${s.id}:world-type`) || BUSY.has(s.status) || (s.external && !s.panelUp);
  const groups = new Map();
  for (const t of s.world.types ?? []) {
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group).push(t);
  }
  const options = [...groups].map(([group, types]) => `<optgroup label="${esc(group)}">${types.map((t) =>
    `<option value="${esc(t.id)}" ${t.id === s.world.type ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</optgroup>`).join("");
  return `
    <div class="stat osrs type-tile">
      <span class="orb">${ICON.crown}</span>
      <div class="type-pick">
        <label class="k" for="world-type">World type</label>
        <div class="select-wrap">
          <select id="world-type" data-world-type ${changing ? "disabled" : ""}
            title="${changing ? "Wait until the world has finished starting or shutting down" : "Change the world type (restarts the server)"}">${options}</select>
        </div>
      </div>
    </div>`;
}

async function changeWorldType(select) {
  const s = current();
  if (!s) return;
  const type = select.value;
  const label = s.world.types.find((t) => t.id === type)?.label ?? type;
  const n = s.world.number;
  const online = s.status === "online";
  const question = online
    ? `Change World ${n} to ${label}?\n\nThe server restarts to apply it.${s.players ? ` ${s.players} player(s) online get a 60-second update countdown first and are saved.` : ""}`
    : `Change World ${n} to ${label}?\n\nIt takes effect the next time you launch the world.`;
  if (!confirm(question)) { select.value = s.world.type; return; }
  busy.add(`${s.id}:world-type`);
  renderWorld();
  try {
    const r = await post(`/api/servers/${s.id}/world-type`, { type });
    if (r.message) toast(r.message, "info");
  } catch (err) {
    toast(err.message);
    select.value = s.world.type;
  } finally {
    busy.delete(`${s.id}:world-type`);
    renderWorld();
  }
}

function renderWorld() {
  const s = current();
  const el = $("#world");
  if (!s) { setHtml(el, `<div class="hero osrs"><h1 class="rs-title">Select a world</h1></div>`); return; }
  const b = (a) => (busy.has(`${s.id}:${a}`) ? "disabled" : "");
  const g = s.git;
  const p = s.ports;
  const exit = s.lastExit
    ? `${s.lastExit.requested ? "Shut down" : "Exited"} ${new Date(s.lastExit.at).toLocaleTimeString()}`
    : "-";
  const sync = !g?.upstream ? "No upstream"
    : g.behind ? `<span class="bad">${g.behind} behind</span>${g.ahead ? `, ${g.ahead} ahead` : ""}`
    : g.ahead ? `${g.ahead} ahead` : `<span class="good">Up to date</span>`;

  setHtml(el, `
    <div class="hero osrs">
      <div>
        <div class="hero-name">
          ${worldIcon(s.world)}
          <h1>World ${s.world.number}</h1>
          <span class="state st-${esc(s.status)}" role="status">${esc(STATUS[s.status] ?? s.status)}</span>
        </div>
        <div class="activity">${esc(activityOf(s))}</div>
        <div class="worldname">${esc(s.world.name)} <span class="dim">- ${esc(s.world.typeLabel ?? (s.world.members ? "Members" : "Free-to-play"))}</span>${s.world.description ? ` <span class="dim">- ${esc(s.world.description)}</span>` : ""}</div>
      </div>
      <div class="hero-actions">${heroActions(s)}</div>
    </div>
    ${banners(s)}
    <div class="stats">
      ${stat(ICON.people, s.status === "online" ? (s.players ?? 0) : "-", "Players online")}
      ${stat(ICON.clock, "-", "Uptime", "uptime")}
      ${typeTile(s)}
      ${stat(ICON.xp, `x${s.world.xp}`, "XP rate")}
    </div>
    <div class="panels">
      <section class="panel osrs">
        <h2 class="rs-title">World info</h2>
        <dl class="kv">
          <dt>Status</dt><dd class="y">${esc(STATUS[s.status] ?? s.status)}</dd>
          <dt>Launched by</dt><dd>${s.managed ? "This panel" : s.external ? "A terminal" : "-"}</dd>
          <dt>Last shutdown</dt><dd>${exit}</dd>
          <dt>Folder</dt><dd>${esc(folderOf(s))}</dd>
        </dl>
        <div class="links">
          ${s.links.worldAdmin && s.panelUp ? `<a class="stone" href="${esc(s.links.worldAdmin)}" target="_blank" rel="noopener">${ICON.settings}World settings</a>` : ""}
        </div>
      </section>
      <section class="panel osrs">
        <h2 class="rs-title">Connection</h2>
        <dl class="kv">
          <dt>Game client</dt><dd class="y">localhost:${p.client}</dd>
          <dt>Game server</dt><dd>${p.game}</dd>
          <dt>World settings</dt><dd>${p.worldAdmin}</dd>
          <dt>Agent MCP</dt><dd>${p.mcp}</dd>
          <dt>Gateway</dt><dd>${p.gateway}</dd>
        </dl>
      </section>
      <section class="panel osrs">
        <h2 class="rs-title">Game update</h2>
        ${g ? `
        <dl class="kv">
          <dt>Branch</dt><dd class="y">${esc(g.branch ?? "?")}</dd>
          <dt>Tracking</dt><dd>${esc(g.upstream ?? "none")}</dd>
          <dt>Status</dt><dd>${sync}</dd>
          <dt>Changes</dt><dd>${g.dirty ? `<span class="bad">${g.dirty} uncommitted</span>` : `<span class="good">None</span>`}</dd>
        </dl>
        ${g.last ? `<div class="commit osrs-inset"><code>${esc(g.last.hash)}</code> ${esc(g.last.subject)} <span class="when">- ${esc(g.last.when)}</span></div>` : ""}
        ${g.upstream ? `<div class="links"><button type="button" class="stone" ${b("pull")} data-act="pull" title="git pull --ff-only">${ICON.update}${g.behind ? `Update (${g.behind} new)` : "Update"}</button></div>` : ""}`
        : `<p class="rs" style="margin:0;color:#e8dcc0">Loading...</p>`}
      </section>
      <section class="panel osrs">
        <h2 class="rs-title">Options</h2>
        <div class="options">
          <label class="osrs-check"><input type="checkbox" data-flag="autostart" ${s.autostart ? "checked" : ""}><span class="box" aria-hidden="true"></span><span>Launch when the panel opens</span></label>
          <p class="hint">Starts this world whenever the admin panel starts.</p>
          <label class="osrs-check"><input type="checkbox" data-flag="autorestart" ${s.autorestart ? "checked" : ""}><span class="box" aria-hidden="true"></span><span>Restart after a crash</span></label>
          <p class="hint">Waits 5 s, 15 s, 30 s, 1 min, 2 min, then 5 min; gives up after 6 crashes in 15 minutes.</p>
        </div>
      </section>
    </div>
    ${s.main ? "" : `
    <div class="danger-zone">
      <h2 class="rs-title">Danger zone</h2>
      <p>Removing World ${s.world.number} deletes its folder (${esc(folderOf(s))}), including its player saves. The <code>${esc(activityOf(s))}</code> branch is kept.</p>
      <button type="button" class="stone red" ${running(s) || b("remove") ? "disabled" : ""} data-remove
        title="${running(s) ? "Shut the world down first" : "Remove this world"}">${ICON.trash}Remove world</button>
    </div>`}`);
  tickUptime();
}

function tickUptime() {
  const s = current();
  const el = document.getElementById("uptime");
  if (el) el.textContent = s?.startedAt ? duration(Date.now() - s.startedAt) : "-";
}

// ---- remove dialog ----

function openRemove() {
  const s = current();
  if (!s) return;
  const changes = s.git?.changes ?? [];
  $("#remove-title").textContent = `Remove World ${s.world.number}?`;
  $("#remove-text").textContent = `This deletes ${s.dir}, including its player saves and logs. The branch ${activityOf(s)} is kept, so you can create the world again later.`;
  $("#remove-changes").hidden = changes.length === 0;
  $("#remove-list").innerHTML = changes.map((c) => `<li>${esc(c)}</li>`).join("");
  $("#remove-discard").checked = false;
  $("#remove-confirm").disabled = changes.length > 0;
  $("#remove-dialog").dataset.id = s.id;
  $("#remove-dialog").dataset.discard = changes.length > 0 ? "1" : "";
  $("#remove-dialog").showModal();
}
$("#remove-discard").onchange = (e) => { $("#remove-confirm").disabled = !e.target.checked; };
$("#remove-dialog").addEventListener("close", () => {
  const d = $("#remove-dialog");
  if (d.returnValue !== "ok") return;
  act(d.dataset.id, "remove", { body: { discard: d.dataset.discard === "1" && $("#remove-discard").checked } });
});

// ---- chatbox console ----

function parse(line) {
  const m = /^\[(server|client)\]\s?(.*)$/.exec(line);
  if (m) return { who: m[1], text: m[2] };
  if (line.startsWith("[admin]")) return { who: "admin", text: line.slice(8) };
  return { who: "", text: line };
}
const isError = (t) => /\b(error|exception|failed|fatal|crash(ed)?)\b/i.test(t);
const isWarn = (t) => /\bwarn(ing)?\b/i.test(t);
const WHO = { server: "Server", client: "Client", admin: "Panel" };

function renderChat() {
  const body = $("#chat-body");
  if (!selected) { body.innerHTML = ""; return; }
  const all = logLines.get(selected);
  if (!all) { body.innerHTML = `<span class="empty">Loading...</span>`; return; }
  const q = $("#chat-search").value.toLowerCase();
  const lines = [];
  for (const e of all.slice(-3000)) {
    const p = parse(e.line);
    if (chatFilter === "error" ? !isError(p.text) : chatFilter !== "all" && p.who !== chatFilter) continue;
    if (q && !e.line.toLowerCase().includes(q)) continue;
    lines.push(p);
  }
  const s = current();
  if (lines.length === 0) {
    body.innerHTML = `<span class="empty">${q || chatFilter !== "all" ? "Nothing matches." : s?.external
      ? "This world was launched from a terminal; its console output is there."
      : "Welcome to the console. Launch the world to see its messages here."}</span>`;
    return;
  }
  body.innerHTML = lines.slice(-2000).map((p) => {
    const cls = p.who === "admin" ? "admin-line" : isError(p.text) ? "err" : isWarn(p.text) ? "warn" : "";
    const who = p.who ? `<span class="who ${p.who}">${WHO[p.who]}:</span> ` : "";
    return `<span class="ln">${who}<span class="${cls}">${esc(p.text)}</span></span>`;
  }).join("");
  if ($("#chat-follow").checked) body.scrollTop = body.scrollHeight;
}
async function loadLogs(id) {
  const res = await fetch(`/api/logs?id=${encodeURIComponent(id)}`);
  if (res.ok) logLines.set(id, (await res.json()).lines);
  if (id === selected) renderChat();
}
document.querySelector(".chat-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[role=tab]");
  if (!tab) return;
  chatFilter = tab.dataset.filter;
  for (const t of document.querySelectorAll(".chat-tabs [role=tab]")) t.setAttribute("aria-selected", String(t === tab));
  renderChat();
});
$("#chat-search").oninput = renderChat;
$("#chat-follow").onchange = renderChat;
let chatQueued = false;

// ---- selection, menu ----

function select(id) {
  if (!state.servers.some((s) => s.id === id)) id = state.servers[0]?.id ?? null;
  const changed = id !== selected;
  selected = id;
  if (id) store.set("tsps-admin:selected", id);
  if (id && location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
  renderSwitcher();
  renderWorld();
  if (changed) {
    $("#chat-search").value = "";
    renderChat();
    if (id) loadLogs(id);
  }
  closeMenu();
}
function closeMenu() {
  $("#switcher").classList.remove("open");
  $("#menu-backdrop").hidden = true;
  $("#menu-toggle").setAttribute("aria-expanded", "false");
}
$("#menu-toggle").onclick = () => {
  const open = !$("#switcher").classList.contains("open");
  $("#switcher").classList.toggle("open", open);
  $("#menu-backdrop").hidden = !open;
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
};
$("#menu-backdrop").onclick = closeMenu;

// ---- events ----

$("#world-list").addEventListener("click", (e) => {
  const row = e.target.closest(".world-row");
  if (row) select(row.dataset.id);
});
$("#world").addEventListener("click", (e) => {
  if (!selected) return;
  if (e.target.closest("button[data-remove]")) return openRemove();
  const btn = e.target.closest("button[data-act]");
  if (btn) act(selected, btn.dataset.act, { confirmText: btn.dataset.confirm });
});
$("#world").addEventListener("change", (e) => {
  if (e.target.matches("select[data-world-type]")) return changeWorldType(e.target);
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
    else { renderSwitcher(); renderWorld(); }
  });
  es.addEventListener("task", (e) => {
    const t = JSON.parse(e.data);
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = t; else state.tasks.unshift(t);
    renderSwitcher();
  });
  es.addEventListener("log", (e) => {
    const { id, t, line } = JSON.parse(e.data);
    const arr = logLines.get(id);
    if (!arr) return; // fetched in full when first selected
    arr.push({ t, line });
    if (arr.length > 3000) arr.splice(0, arr.length - 3000);
    if (id === selected && !chatQueued) { chatQueued = true; requestAnimationFrame(() => { chatQueued = false; renderChat(); }); }
  });
}
connect();
setInterval(tickUptime, 1000);
