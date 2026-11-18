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

/** The world type as the list's Activity column shows it: "Leagues VI - Demonic Pacts" becomes "Leagues VI". */
const typeName = (world) => world.typeLabel ?? (world.members === false ? "Free-to-play" : "Members");
const shortType = (world) => typeName(world).replace(/\s+-\s+.*$/, "");
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
      ${s.id === selected ? 'aria-current="true"' : ""} title="World ${s.world.number}: ${esc(typeName(s.world))}, ${esc(STATUS[s.status] ?? s.status)} (branch ${esc(activityOf(s))})">
      ${worldIcon(s.world)}
      <span class="num">${s.world.number}</span>
      <span class="count">${count}</span>
      <span class="activity">${esc(shortType(s.world))}</span>
    </button>`;
  }).join("") || `<p class="rs" style="margin:6px;color:#e8dcc0">No worlds yet. Create one.</p>`);

  const online = state.servers.filter((s) => s.status === "online");
  const players = online.reduce((n, s) => n + (s.players ?? 0), 0);
  setHtml($("#total"), `<b>${players}</b> players on <b>${online.length}</b> of ${state.servers.length} worlds`);

  renderJobs();
}

// ---- Recent jobs ----

const JOB_ICON = {
  create: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></svg>',
  update: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></svg>',
  fetch: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" /></svg>',
};
const openJobs = new Set(); // jobs whose Details are expanded, kept across redraws

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** The newest line of a running job worth showing, e.g. "Updating files: 45% (4248/9439)". */
function liveLine(lines) {
  const line = [...lines].reverse().find((l) => l.trim());
  return line ? line.trim().replace(/^(remote|fatal|error):\s*/i, "") : "Starting...";
}

function jobStatus(t) {
  if (t.state === "running") {
    return `<span class="job-state running">Working ${clock(Date.now() - t.at)}</span><span class="job-msg">${esc(liveLine(t.lines))}</span>`;
  }
  const took = t.endedAt && t.endedAt - t.at >= 2000 ? ` in ${clock(t.endedAt - t.at)}` : "";
  return t.state === "done"
    ? `<span class="job-state done">${esc(t.summary ?? "Done")}</span><span class="job-when">${ago(t.endedAt ?? t.at)}${took}</span>`
    : `<span class="job-state failed">Failed</span><span class="job-msg">${esc(t.summary ?? "See details")}</span><span class="job-when">${ago(t.endedAt ?? t.at)}</span>`;
}

/** A job with this key is running (the server hands it back rather than starting a second). */
const jobRunning = (key) => (state.tasks ?? []).some((t) => t.key === key && t.state === "running");

/** "Check for updates" rests while a check runs, then comes back. */
function renderFetchButton() {
  const checking = jobRunning("fetch") || busy.has("fetch");
  const btn = $("#fetch");
  btn.disabled = checking;
  btn.querySelector(".label").textContent = checking ? "Checking..." : "Check for updates";
}

function renderJobs() {
  renderFetchButton();
  const jobs = (state.tasks ?? []).slice(0, 6);
  $("#jobs-wrap").hidden = jobs.length === 0;
  $("#jobs-clear").hidden = !jobs.some((t) => t.state !== "running");
  setHtml($("#jobs"), jobs.map((t) => `
    <article class="job j-${esc(t.state)} k-${esc(t.kind ?? "job")}" data-id="${esc(t.id)}">
      <span class="job-icon">${JOB_ICON[t.kind] ?? JOB_ICON.fetch}</span>
      <div class="job-body">
        <div class="job-title">${esc(t.title ?? "Job")}${t.detail ? ` <span class="job-detail">${esc(t.detail)}</span>` : ""}</div>
        <div class="job-status">${jobStatus(t)}</div>
        ${t.lines.length ? `<details class="job-log" data-id="${esc(t.id)}" ${openJobs.has(t.id) ? "open" : ""}>
          <summary>Details</summary><pre>${esc(t.lines.filter((l, i, a) => l || a[i - 1]).join("\n"))}</pre></details>` : ""}
      </div>
    </article>`).join(""));
  for (const pre of document.querySelectorAll(".job-log[open] pre")) pre.scrollTop = pre.scrollHeight;
}

$("#jobs").addEventListener("toggle", (e) => {
  const d = e.target.closest?.(".job-log");
  if (!d) return;
  if (d.open) { openJobs.add(d.dataset.id); d.querySelector("pre").scrollTop = 1e9; } else openJobs.delete(d.dataset.id);
}, true);
$("#jobs-clear").onclick = () => post("/api/tasks/clear").catch((err) => toast(err.message));
setInterval(() => { if (state.tasks?.length) renderJobs(); }, 1000);

// ---- selected world ----

/** One Connection row: what it is, the address (a link when it opens in a browser), and Copy. */
function address(label, value, { href = null, hint = "" } = {}) {
  const shown = esc(value.replace(/^https?:\/\//, ""));
  return `
    <li class="address" ${hint ? `title="${esc(hint)}"` : ""}>
      <span class="addr-label">${esc(label)}</span>
      ${href ? `<a class="addr-value link" href="${esc(href)}" target="_blank" rel="noopener">${shown}</a>` : `<span class="addr-value">${shown}</span>`}
      <button type="button" class="addr-btn" data-copy="${esc(value)}" aria-label="Copy ${esc(label)} address">Copy</button>
    </li>`;
}

function heroActions(s) {
  const b = (a) => (busy.has(`${s.id}:${a}`) ? "disabled" : "");
  const n = s.world.number;
  const stopping = s.status === "stopping";
  const play = running(s) && s.status === "online"
    ? `<a class="play" href="${esc(s.links.client)}" target="_blank" rel="noopener">Play<small>World ${n}</small></a>`
    : `<span class="play off" aria-disabled="true">Play<small>${esc(STATUS[s.status] ?? s.status)}</small></span>`;

  // Three buttons of one size under Play, always in the same places: power, restart, settings.
  // One that can't be used now stays, greyed, with a tooltip saying why.
  const off = (icon, label, why) => `<button type="button" class="stone" disabled title="${esc(why)}">${icon}${label}</button>`;
  const shutDown = () => {
    const confirmText = s.external
      ? `Shut down World ${n}? It was launched from a terminal: online players are saved, then the processes on its ports are ended.`
      : `Shut down World ${n}? Online players are saved first.`;
    return `<button type="button" class="stone red" ${stopping ? "disabled" : b("stop")} data-act="stop" data-confirm="${esc(confirmText)}"
      title="Save players and stop World ${n}">${ICON.power}${stopping ? "Stopping" : "Shut down"}</button>`;
  };
  const gameDown = running(s) && (s.status === "game-stopped" || s.status === "failed");

  let first;
  let second;
  if (!running(s)) {
    first = `<button type="button" class="stone gold" ${b("start")} data-act="start" title="Start World ${n}">${ICON.power}Launch</button>`;
    second = off(ICON.restart, "Restart", "Launch the world first");
  } else if (gameDown) {
    // The process is up but the game isn't: start the game, or shut the whole world down.
    first = `<button type="button" class="stone gold" ${b("game-start")} data-act="game-start" title="Start the game again">${ICON.power}Start</button>`;
    second = shutDown();
  } else {
    first = shutDown();
    const act = s.managed ? "restart" : "game-restart";
    second = stopping || !(s.managed || s.panelUp)
      ? off(ICON.restart, "Restart", stopping ? "World is shutting down" : "Restart it from the terminal it was launched in")
      : `<button type="button" class="stone" ${b(act)} data-act="${act}" title="Save players and restart World ${n}">${ICON.restart}Restart</button>`;
  }
  const settings = s.links.worldAdmin && s.panelUp
    ? `<a class="stone" href="${esc(s.links.worldAdmin)}" target="_blank" rel="noopener" title="Open World ${n}'s settings page">${ICON.settings}Settings</a>`
    : off(ICON.settings, "Settings", "The world settings page opens while the world is running");
  return `${play}<div class="world-buttons">${first}${second}${settings}</div>`;
}

/**
 * While the world goes down or comes back, this takes the stat tiles' place, drawn like one wide tile
 * (same height, so the page never grows): the in-game update countdown ("System update in 0:47"),
 * a shutdown, restart or launch with a running clock and the step it's on, or the wait before an
 * automatic restart after a crash. The longer explanation is its tooltip.
 */
function transitionBanner(s) {
  const n = s.world.number;
  const tile = ({ icon, kind, title, line, tip, extra = "" }) => `
    <div class="transit osrs ${kind}" role="status" ${tip ? `title="${esc(tip)}"` : ""}>
      <span class="orb">${icon}</span>
      <div class="tr-text"><div class="v">${title}</div><div class="k">${esc(line)}</div></div>
      ${extra}
    </div>`;

  const cd = s.countdown;
  if (cd && cd.endsAt > Date.now()) {
    return tile({
      icon: ICON.clock, kind: "update",
      title: `System update in <span data-until="${cd.endsAt}"></span>`,
      line: cd.reason === "settings" ? "Restarting to apply the new world settings" : "Update started in game",
      tip: `World ${n} restarts when it reaches 0:00. Players are saved first.`,
      extra: `<button type="button" class="stone" ${busy.has(`${s.id}:cancel-update`) ? "disabled" : ""} data-act="cancel-update">Cancel</button>
        <div class="tr-bar"><span data-bar-until="${cd.endsAt}" data-total="${(cd.total || 60) * 1000}"></span></div>`,
    });
  }
  const t = s.transition;
  if (t) {
    const saving = t.players ? `Saving ${t.players} player${t.players === 1 ? "" : "s"}` : "Saving players";
    const steps = {
      shutdown: [[saving, "saving"], ["Closing the server", "closing"]],
      restart: [[saving, "saving"], ["Starting the server", "starting"]],
      launch: [["Starting the server", "starting"]],
    }[t.kind] ?? [];
    const at = Math.max(0, steps.findIndex(([, phase]) => phase === t.phase));
    const step = steps[at]?.[0] ?? "Working";
    return tile({
      icon: ICON.power, kind: t.kind,
      title: `${{ shutdown: "Shutting down", restart: "Restarting", launch: "Launching" }[t.kind] ?? "Working"} World ${n}
        <span class="tr-clock" data-since="${t.startedAt}"></span>`,
      line: steps.length > 1 ? `${step} (step ${at + 1} of ${steps.length})` : step,
      tip: t.phase === "saving" && t.deadline
        ? `If saving takes longer than ${clock(t.deadline - t.startedAt)}, the server is stopped anyway.`
        : t.phase === "starting" ? "Usually ready in under a minute; the console below shows progress." : "",
    });
  }
  if (s.retryAt && s.retryAt > Date.now()) {
    return tile({
      icon: ICON.restart, kind: "restart",
      title: `Restarting after a crash in <span data-until="${s.retryAt}"></span>`,
      line: "Shut down to stop it trying again",
      tip: `Restart after a crash is on for World ${n}.`,
    });
  }
  return "";
}

/** Moves every banner clock and bar on by a second, without redrawing the world view. */
function tickTimers() {
  const now = Date.now();
  for (const el of document.querySelectorAll("[data-until]")) el.textContent = clock(Math.max(0, Number(el.dataset.until) - now));
  for (const el of document.querySelectorAll("[data-since]")) el.textContent = clock(now - Number(el.dataset.since));
  for (const el of document.querySelectorAll("[data-bar-until]")) {
    const left = Math.max(0, Number(el.dataset.barUntil) - now);
    el.style.width = `${Math.min(100, (left / Number(el.dataset.total)) * 100)}%`;
  }
}

function banners(s) {
  const out = [];
  if (s.external) out.push(`<div class="banner info">This world was launched from a terminal, so its console is there. Shut down still saves players first.</div>`);
  // While the crash restart counts down, its banner already says so.
  const waiting = s.retryAt && s.retryAt > Date.now();
  if (s.note && !waiting) out.push(`<div class="banner ${/stopped unexpectedly|Gave up/.test(s.note) ? "error" : "warn"}">${esc(s.note)}</div>`);
  return out.join("");
}

function stat(icon, value, label, id) {
  return `<div class="stat osrs"><span class="orb">${icon}</span><div><div class="v"${id ? ` id="${id}"` : ""}>${value}</div><div class="k">${label}</div></div></div>`;
}

/** The World type dropdown's button, in the world heading. Its list is #type-menu. */
function typePicker(s) {
  const label = `<span class="type-label">${esc(typeName(s.world))}</span>`;
  // A panel process older than world types sends none: show the type without the dropdown.
  if (!s.world.types?.length) return `<div class="type-pick"><span class="type-static">${worldIcon(s.world)}${label}</span></div>`;
  const changing = busy.has(`${s.id}:world-type`) || BUSY.has(s.status) || (s.external && !s.panelUp);
  return `
    <div class="type-pick">
      <button type="button" id="type-select" class="type-select" data-type-menu aria-haspopup="listbox" aria-label="World type: ${esc(typeName(s.world))}"
        aria-expanded="${menuFor() === s.id}" aria-controls="type-menu" ${changing ? "disabled" : ""}
        title="${changing ? "Wait until the world has finished starting or shutting down" : "Change the world type (restarts the server)"}">
        ${worldIcon(s.world)}${label}<span class="caret" aria-hidden="true"></span>
      </button>
    </div>`;
}

// ---- World type dropdown (a listbox, so each type can show its world icon) ----
// One list serves every picker: the world heading's and the New world dialog's. `menuCtx` says which
// opened it: { owner, trigger() (looked up each time, since the world view is redrawn), types, value, choose }.

const menu = $("#type-menu");
let menuCtx = null;
let menuIndex = 0;
const menuOptions = () => [...menu.querySelectorAll("[role=option]")];
const menuFor = () => menuCtx?.owner ?? null;

function openTypeMenu(ctx) {
  if (!ctx) return;
  const trigger = ctx.trigger();
  if (!trigger || trigger.disabled || !ctx.types?.length) return;
  const groups = new Map();
  for (const t of ctx.types) {
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group).push(t);
  }
  let i = 0;
  menu.innerHTML = [...groups].map(([group, types]) => `
    <div class="menu-group" role="group" aria-label="${esc(group)}">
      <div class="menu-label" aria-hidden="true">${esc(group)}</div>
      ${types.map((t) => `
        <div class="menu-opt" role="option" id="type-opt-${i++}" data-type="${esc(t.id)}" aria-selected="${t.id === ctx.value}">
          ${worldIcon({ type: t.id, typeLabel: t.label, members: t.id !== "f2p" })}<span>${esc(t.label)}</span>
        </div>`).join("")}
    </div>`).join("");
  // A modal dialog sits in the browser's top layer, above everything else: the list must be inside it.
  (trigger.closest("dialog") ?? document.body).appendChild(menu);
  menuCtx = ctx;
  menuIndex = Math.max(0, menuOptions().findIndex((o) => o.dataset.type === ctx.value));
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  positionMenu();
  highlight();
  menu.focus();
}

function positionMenu() {
  if (menu.hidden) return;
  const trigger = menuCtx?.trigger();
  if (!trigger) return closeTypeMenu();
  const r = trigger.getBoundingClientRect();
  menu.style.minWidth = `${Math.max(r.width, 260)}px`;
  const h = menu.offsetHeight;
  const w = menu.offsetWidth;
  const below = window.innerHeight - r.bottom;
  menu.style.top = `${below < h + 8 && r.top > h + 8 ? r.top - h - 4 : r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
}

function closeTypeMenu(refocus = false) {
  if (menu.hidden) return;
  menu.hidden = true;
  const trigger = menuCtx?.trigger();
  menuCtx = null;
  document.body.appendChild(menu);
  trigger?.setAttribute("aria-expanded", "false");
  if (refocus) trigger?.focus();
}

function highlight() {
  const opts = menuOptions();
  opts.forEach((o, i) => o.classList.toggle("active", i === menuIndex));
  if (opts[menuIndex]) {
    menu.setAttribute("aria-activedescendant", opts[menuIndex].id);
    opts[menuIndex].scrollIntoView({ block: "nearest" });
  }
}

function chooseType(type) {
  const ctx = menuCtx;
  closeTypeMenu(true);
  if (ctx && type) ctx.choose(type);
}

/** The world heading's picker: changes the selected world's type. */
function worldTypeMenu() {
  const s = current();
  return s && {
    owner: s.id,
    trigger: () => $("#type-select"),
    types: s.world.types,
    value: s.world.type,
    choose: (type) => { if (type !== current()?.world.type) changeWorldType(type); },
  };
}

menu.addEventListener("keydown", (e) => {
  const opts = menuOptions();
  const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (move) menuIndex = (menuIndex + move + opts.length) % opts.length;
  else if (e.key === "Home") menuIndex = 0;
  else if (e.key === "End") menuIndex = opts.length - 1;
  else if (e.key === "Enter" || e.key === " ") return e.preventDefault(), chooseType(opts[menuIndex]?.dataset.type);
  // Escape closes just the list, not the dialog around it.
  else if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), closeTypeMenu(true);
  else if (e.key === "Tab") return closeTypeMenu();
  else return;
  e.preventDefault();
  highlight();
});
menu.addEventListener("mousemove", (e) => {
  const i = menuOptions().indexOf(e.target.closest("[role=option]"));
  if (i >= 0 && i !== menuIndex) { menuIndex = i; highlight(); }
});
menu.addEventListener("click", (e) => {
  const opt = e.target.closest("[role=option]");
  if (opt) chooseType(opt.dataset.type);
});
document.addEventListener("mousedown", (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !e.target.closest("[data-type-menu]")) closeTypeMenu();
});
window.addEventListener("resize", () => closeTypeMenu());
document.addEventListener("scroll", () => positionMenu(), true);

async function changeWorldType(type) {
  const s = current();
  if (!s) return;
  const label = s.world.types.find((t) => t.id === type)?.label ?? type;
  const n = s.world.number;
  const online = s.status === "online";
  const question = online
    ? `Change World ${n} to ${label}?\n\nThe server restarts to apply it.${s.players ? ` ${s.players} player(s) online get a 60-second update countdown first and are saved.` : ""}`
    : `Change World ${n} to ${label}?\n\nIt takes effect the next time you launch the world.`;
  if (!confirm(question)) return;
  busy.add(`${s.id}:world-type`);
  renderWorld();
  try {
    const r = await post(`/api/servers/${s.id}/world-type`, { type });
    if (r.message) toast(r.message, "info");
  } catch (err) {
    toast(err.message);
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
  const lastExit = s.lastExit ? new Date(s.lastExit.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  // Commits waiting: the ones on the branch it tracks, plus (when that's a fork's main) the ones its
  // parent has that the fork hasn't picked up yet.
  const forkBehind = g?.fork?.behind ?? 0;
  const waiting = (g?.behind ?? 0) + forkBehind;
  const sync = !g?.upstream ? "No upstream"
    : waiting ? `<span class="bad">${waiting} behind</span>${g.ahead ? `, ${g.ahead} ahead` : ""}`
    : g.ahead ? `${g.ahead} ahead` : `<span class="good">Up to date</span>`;
  const pullTip = g?.fork?.repo
    ? `Syncs your fork ${g.fork.repo} with ${g.fork.parent} on GitHub (like its Sync fork button), then pulls`
    : "git pull --ff-only";

  setHtml(el, `
    <div class="hero osrs">
      <div class="hero-main">
        <div class="hero-name">
          <h1>World ${s.world.number}</h1>
          <span class="state st-${esc(s.status)}" role="status">${esc(STATUS[s.status] ?? s.status)}</span>
        </div>
        ${typePicker(s)}
        <div class="worldname">${esc(s.world.name)}${s.world.description ? ` <span class="dim">- ${esc(s.world.description)}</span>` : ""}
          <span class="dim">- branch</span> <span class="branch">${esc(activityOf(s))}</span></div>
      </div>
      <div class="hero-actions">${heroActions(s)}</div>
    </div>
    ${banners(s)}
    ${transitionBanner(s) || `
    <div class="stats">
      ${stat(ICON.people, s.status === "online" ? (s.players ?? 0) : "-", "Players online")}
      ${!running(s) && lastExit ? stat(ICON.clock, lastExit, "Last shut down") : stat(ICON.clock, "-", "Uptime", "uptime")}
      ${stat(ICON.xp, `x${s.world.xp}`, "XP rate")}
      ${stat(ICON.crown, s.managed ? "This panel" : s.external ? "A terminal" : "-", "Launched by")}
    </div>`}
    <div class="panels">
      <section class="panel osrs">
        <h2 class="rs-title">Connection</h2>
        <ul class="addresses">
          ${address("Game client", s.links.client, { href: running(s) ? s.links.client : null, hint: "Open in a browser to play" })}
          ${address("Game server", `localhost:${p.game}`, { hint: "The game's WebSocket port" })}
          ${address("Agent MCP", s.links.mcp, { hint: "For Claude Code: claude mcp add --transport http tsps <address>" })}
          ${address("RuneLite gateway", `localhost:${p.gateway}`, { hint: "For the official client through RSProx" })}
          <li class="address">
            <span class="addr-label">Folder</span>
            <span class="addr-value" title="${esc(s.dir)}">${esc(folderOf(s))}</span>
            <button type="button" class="addr-btn" ${b("open-folder")} data-act="open-folder" title="Show the folder in Explorer">Open</button>
          </li>
        </ul>
      </section>
      <section class="panel osrs">
        <h2 class="rs-title">Game update</h2>
        ${g ? `
        <dl class="kv">
          <dt>Branch</dt><dd class="y">${esc(g.branch ?? "?")}</dd>
          <dt>Tracking</dt><dd>${esc(g.fork?.parent ? `${g.fork.parent} (via ${g.upstream})` : g.upstream ?? "none")}</dd>
          <dt>Status</dt><dd>${sync}</dd>
          <dt>Changes</dt><dd>${g.dirty ? `<span class="bad">${g.dirty} uncommitted</span>` : `<span class="good">None</span>`}</dd>
        </dl>
        ${g.last ? `<div class="commit osrs-inset"><code>${esc(g.last.hash)}</code> ${esc(g.last.subject)} <span class="when">- ${esc(g.last.when)}</span></div>` : ""}
        ${g.upstream ? (jobRunning(`update:${s.id}`) || busy.has(`${s.id}:pull`)
          ? `<div class="links"><button type="button" class="stone" disabled>${ICON.update}Updating...</button></div>`
          : `<div class="links"><button type="button" class="stone" data-act="pull" title="${esc(pullTip)}">${ICON.update}${waiting ? `Update (${waiting} new)` : "Update"}</button></div>`) : ""}`
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
  tickTimers();
  if (menuFor() && menuFor() !== s.id && menuFor() !== "new") closeTypeMenu();
  else positionMenu();
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
  if (e.target.closest("button[data-type-menu]")) return menu.hidden ? openTypeMenu(worldTypeMenu()) : closeTypeMenu(true);
  const copy = e.target.closest("button[data-copy]");
  if (copy) {
    return navigator.clipboard.writeText(copy.dataset.copy)
      .then(() => { copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1500); })
      .catch(() => toast("Couldn't copy; select the address and copy it by hand."));
  }
  const btn = e.target.closest("button[data-act]");
  if (btn) act(selected, btn.dataset.act, { confirmText: btn.dataset.confirm });
});
$("#world").addEventListener("keydown", (e) => {
  if (e.target.closest("button[data-type-menu]") && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    openTypeMenu(worldTypeMenu());
  }
});
$("#world").addEventListener("change", (e) => {
  const flag = e.target.dataset?.flag;
  if (flag && selected) post(`/api/servers/${selected}/flags`, { [flag]: e.target.checked }).catch((err) => toast(err.message));
});
$("#fetch").onclick = () => {
  if (jobRunning("fetch") || busy.has("fetch")) return;
  busy.add("fetch");
  renderFetchButton();
  post("/api/git/fetch").catch((err) => toast(err.message)).finally(() => { busy.delete("fetch"); renderFetchButton(); });
};
// ---- New world ----

/** A typed name as a branch git accepts: spaces become dashes, characters git refuses are dropped. */
function branchFromName(name) {
  return name.trim()
    .replace(/\s+/g, "-")
    .replace(/[~^:?*[\]\\@{}<>|"'`!$&;,#%]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-")
    .split("/").map((part) => part.replace(/^[.-]+/, "").replace(/(\.lock)+$|\.+$/g, "")).filter(Boolean).join("/");
}

/** What `scripts/wt new` will make: the next free slot (as a world number) and the folder beside the main checkout. */
function newWorldPlan(branch) {
  const used = new Set(state.servers.map((s) => s.ports.slot).filter(Boolean));
  let slot = 1;
  while (used.has(slot) && slot < 99) slot++;
  const main = (state.repo ?? "tsps").split(/[\\/]/).pop();
  return { number: 1 + slot, folder: `${main}-${branch.replace(/\//g, "-")}` };
}

let pendingWorld = null; // { folder, number, task } until the new world shows up in the list
let newType = "members";

/** A new world starts from main, so it offers the main checkout's types. */
function newWorldTypes() {
  return state.servers.find((s) => s.main)?.world.types
    ?? [{ id: "members", label: "Members", group: "Standard" }, { id: "f2p", label: "Free-to-play", group: "Standard" }];
}
const newTypeInfo = () => newWorldTypes().find((t) => t.id === newType) ?? newWorldTypes()[0];
const newTypeWorld = () => ({ type: newTypeInfo().id, typeLabel: newTypeInfo().label, members: newTypeInfo().id !== "f2p" });

function renderNewType() {
  $("#new-type").innerHTML = `${worldIcon(newTypeWorld())}<span class="type-label">${esc(newTypeInfo().label)}</span><span class="caret" aria-hidden="true"></span>`;
}

const newTypeMenu = () => ({
  owner: "new",
  trigger: () => $("#new-type"),
  types: newWorldTypes(),
  value: newTypeInfo().id,
  choose: (type) => { newType = type; renderNewType(); updateNewWorld(); },
});
$("#new-type").addEventListener("click", () => (menu.hidden ? openTypeMenu(newTypeMenu()) : closeTypeMenu(true)));
$("#new-type").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openTypeMenu(newTypeMenu()); }
});
$("#new-dialog").addEventListener("close", () => closeTypeMenu());

function updateNewWorld() {
  const name = $("#new-name").value;
  const branch = branchFromName(name);
  const taken = state.servers.find((s) => s.branch === branch);
  const error = !name.trim() ? "" : !branch ? "Use letters, numbers and dashes." : taken ? `World ${taken.world.number} already uses this name.` : "";
  const plan = newWorldPlan(branch);
  $("#new-preview").innerHTML = branch && !error ? `
    ${worldIcon(newTypeWorld())}
    <div><div class="new-number">World ${plan.number} <span class="new-type">${esc(newTypeInfo().label)}</span></div>
    <div class="new-detail">Branch <code>${esc(branch)}</code> in <code>${esc(plan.folder)}</code></div></div>` : "";
  $("#new-error").textContent = error;
  $("#new-error").hidden = !error;
  $("#new-create").disabled = !branch || !!error;
  return { branch, error, plan };
}

$("#new").onclick = () => {
  $("#new-form").reset();
  $("#new-form").querySelector(".advanced").open = false;
  newType = "members";
  renderNewType();
  updateNewWorld();
  $("#new-dialog").showModal();
  $("#new-name").focus();
};
$("#new-name").addEventListener("input", updateNewWorld);
$("#new-cancel").onclick = () => $("#new-dialog").close("cancel");
$("#new-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { branch, error, plan } = updateNewWorld();
  if (!branch || error) return;
  const base = $("#new-base").value.trim();
  $("#new-create").disabled = true;
  try {
    const type = newTypeInfo();
    const r = await post("/api/worktrees", { branch, base, type: type.id });
    $("#new-dialog").close("ok");
    pendingWorld = { ...plan, task: r.task };
    toast(`Creating World ${plan.number} (${type.label}). It opens here when it's ready, in a few minutes.`, "info");
  } catch (err) {
    $("#new-error").textContent = err.message;
    $("#new-error").hidden = false;
    $("#new-create").disabled = false;
  }
});

/** Opens the new world once it appears, or reports why it wasn't created. */
function watchNewWorld() {
  if (!pendingWorld) return;
  const made = state.servers.find((s) => s.dir.split(/[\\/]/).pop().toLowerCase() === pendingWorld.folder.toLowerCase());
  if (made) {
    toast(`World ${made.world.number} is ready. Launch it when you like.`, "info");
    pendingWorld = null;
    select(made.id);
    return;
  }
  const task = state.tasks.find((t) => t.id === pendingWorld.task);
  if (task?.state === "failed") {
    toast(`World ${pendingWorld.number} wasn't created: ${task.lines.filter(Boolean).at(-1) ?? "see Recent jobs"}`);
    pendingWorld = null;
  }
}
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
    watchNewWorld();
  });
  es.addEventListener("task", (e) => {
    const t = JSON.parse(e.data);
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = t; else state.tasks.unshift(t);
    renderSwitcher();
    renderWorld(); // its Update button rests while the update runs (only redraws when that changes)
    watchNewWorld();
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
setInterval(() => { tickUptime(); tickTimers(); }, 1000);
