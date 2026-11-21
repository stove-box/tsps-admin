"use strict";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let state = { servers: [], tasks: [] };
let selected = null;
let chatFilter = "all";
let worldTab = "update"; // the world view's tab: "update" (Options) or "connection"
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
  return `<img class="star sprite ${k.kind}" src="${sprite.src}" width="${sprite.size}" height="${sprite.size}" alt="${esc(label)} world">`;
}

/** The world type as the list's Activity column shows it: "Leagues VI - Demonic Pacts" becomes "Leagues VI". */
const typeName = (world) => world.typeLabel ?? (world.members === false ? "Free-to-play" : "Members");
const shortType = (world) => typeName(world).replace(/\s+-\s+.*$/, "");
const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>',
  power: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9" /><path d="M6.3 6.3a8 8 0 1 0 11.4 0" /></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>',
  update: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></svg>',
  people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" /></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>',
  xp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19l5-6 4 3 7-9" /><path d="M15 7h5v5" /></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" /></svg>',
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
if (store.get("tsps-admin:tab") === "connection") worldTab = "connection";

/** Shows world tab `id` and keeps focus on its tab (the world view is redrawn). */
function showTab(id) {
  worldTab = id;
  store.set("tsps-admin:tab", id);
  renderWorld();
  $(`#tab-${id}`)?.focus();
}

/** Page-only cards beside the server's jobs (info messages); they leave after 10 s like finished jobs. */
let notes = [];

function toast(msg, kind = "error") {
  if (kind === "info") {
    notes = [...notes, { id: `note-${Date.now()}`, kind: "note", state: "done", summary: msg, at: Date.now(), lines: [] }];
    return renderJobs();
  }
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

/**
 * The panel's own "Are you sure?" dialog (stone, RuneScape title, Yes / No) instead of the browser's
 * confirm(). Focus starts on No, so a stray Enter doesn't do the thing; Escape also says no.
 * Resolves to true only for Yes.
 */
function askConfirm({ title, text = "", yes = "Yes", no = "No", danger = false, list = null, check = null, card = "", note = "" }) {
  const d = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-text").hidden = !text;
  // Optional preview card (markup built by the caller from escaped values) and a closing note.
  $("#confirm-card").innerHTML = card;
  $("#confirm-card").hidden = !card;
  $("#confirm-note").textContent = note;
  $("#confirm-note").hidden = !note;
  $("#confirm-yes").textContent = yes;
  $("#confirm-yes").className = `stone ${danger ? "red" : "gold"}`;
  $("#confirm-no").textContent = no;
  // Optional extras (Remove world): a list to show, and a box that must be ticked before Yes works.
  $("#confirm-more").hidden = !list && !check;
  $("#confirm-list-title").textContent = list?.title ?? "";
  $("#confirm-list-title").hidden = !list;
  $("#confirm-list").hidden = !list;
  $("#confirm-list").innerHTML = (list?.items ?? []).map((i) => `<li>${esc(i)}</li>`).join("");
  $("#confirm-check").checked = false;
  $("#confirm-check").closest("label").hidden = !check;
  $("#confirm-check-label").textContent = check ?? "";
  $("#confirm-yes").disabled = !!check;
  $("#confirm-check").onchange = (e) => { $("#confirm-yes").disabled = !e.target.checked; };
  d.returnValue = "";
  d.showModal();
  $("#confirm-no").focus();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "yes"), { once: true }));
}

/** What the Shut down button asks, worded for this world as it is now. */
function shutdownQuestion(s) {
  const n = s.world.number;
  const on = s.status === "online" ? s.players ?? 0 : 0;
  return {
    title: `Shut down World ${n}?`,
    card: `<ul class="restart-list"><li>${worldIcon(s.world)}<span class="rl-n">World ${n}</span>
      <span class="rl-t">${esc(shortType(s.world))}</span><span class="rl-p">${on} online</span></li></ul>`,
    note: on ? `${on} player${on === 1 ? " is" : "s are"} saved first.` : "The world goes offline.",
    yes: "Shut down",
    no: "Cancel",
    danger: true,
  };
}

/** What the Restart button asks, laid out like the World type change: intro, a card of the steps, a note. */
function restartQuestion(s) {
  const n = s.world.number;
  const save = s.status === "online" && s.players ? `Save ${s.players} player${s.players === 1 ? "" : "s"}` : "Save players";
  const step = (text, cls = "from") => `<span class="${cls}"><span>${esc(text)}</span></span>`;
  const arrow = `<span class="arrow" aria-hidden="true">&rarr;</span>`;
  return {
    title: `Restart World ${n}?`,
    card: `<div class="type-change">${step(save)}${arrow}${step("Shut down")}${arrow}${step("Start up", "to")}</div>`,
    note: s.status === "online" && s.players ? "Players are offline for about a minute." : "Back online in about a minute.",
    yes: "Restart",
    no: "Cancel",
  };
}

const QUESTIONS = { stop: shutdownQuestion, restart: restartQuestion };

async function act(id, action, { ask, body } = {}) {
  if (ask && !(await askConfirm(ask))) return;
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

/**
 * Text that changes, in a box that doesn't: every version is laid out in the same spot and only `text`
 * shows, so the box is always as wide as the longest one (world heading, status pill, Update, Copy).
 */
function steady(text, all) {
  const list = all.includes(text) ? all : [text, ...all];
  return `<span class="steady">${list.map((t) => `<span${t === text ? "" : ' class="ghost" aria-hidden="true"'}>${esc(t)}</span>`).join("")}</span>`;
}

// Only touch the DOM when the markup changed, so a click isn't lost to a redraw every poll.
function setHtml(el, html) {
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

// ---- World Switcher ----

/** A greyed placeholder row for each world still being created, until the real one appears. */
function creatingRows() {
  return (state.tasks ?? []).filter((t) => t.kind === "create" && t.state === "running").map((t) => {
    const type = t.type ?? "members";
    const label = newWorldTypes().find((x) => x.id === type)?.label ?? "Members";
    return `
    <div class="world-row is-creating" role="note">
      ${worldIcon({ type, typeLabel: label, members: type !== "f2p" })}
      <span class="num">...</span>
      <span class="count">...</span>
      <span class="activity">Creating...</span>
    </div>`;
  }).join("");
}

let reorder = null; // world ids top to bottom while the World Switcher's Edit is open, else null

let dragging = null; // the world id being dragged in Edit mode

/** A row in Edit mode: its new number and a grip. Drag it, or focus it and press the up/down arrow keys. */
const offline = (s) => s.status === "offline" || s.status === "game-stopped" || s.status === "failed";

function editRow(s, i, count) {
  const n = `World ${s.world.number} (${esc(activityOf(s))})`;
  return `
    <div class="world-row is-editing ${offline(s) ? "is-offline" : ""} ${s.id === dragging ? "is-dragging" : ""}" data-id="${esc(s.id)}" tabindex="0"
      ${s.id === selected ? 'aria-current="true"' : ""}
      aria-label="${n}, position ${i + 1} of ${count}. Drag, or press the up and down arrow keys, to move it.">
      ${worldIcon(s.world)}
      <span class="num">${i + 1}</span>
      <span class="grip" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 8h14M5 12h14M5 16h14" /></svg></span>
      <span class="activity">${esc(shortType(s.world))}</span>
    </div>`;
}

/** Edit mode: moves world `id` to place `to` in the list and redraws, sliding the rows from where they were. */
function moveTo(id, to) {
  const rows = () => [...$("#world-list").children];
  const was = new Map(rows().map((r) => [r.dataset.id, r.getBoundingClientRect().top]));
  reorder.splice(reorder.indexOf(id), 1);
  reorder.splice(to, 0, id);
  renderSwitcher();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const r of rows()) {
    const dy = was.get(r.dataset.id) - r.getBoundingClientRect().top;
    if (!dy || r.dataset.id === dragging) continue; // the dragged row stays under the pointer
    // Not hit-testable while it slides: the drag would otherwise find it under the pointer and swap it straight back.
    r.style.pointerEvents = "none";
    r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 180, easing: "ease-out" })
      .finished.finally(() => { r.style.pointerEvents = ""; });
  }
}

function renderSwitcher() {
  $("#reorder").hidden = !!reorder;
  $("#new").hidden = !!reorder;
  $("#reorder-cancel").hidden = !reorder;
  $("#reorder-save").hidden = !reorder;
  $("#switcher").classList.toggle("reordering", !!reorder);
  $("#reorder").disabled = state.servers.length < 2;
  if (reorder) {
    // Worlds added or removed while editing: drop the gone ones, add new ones at the bottom.
    const ids = new Set(state.servers.map((s) => s.id));
    reorder = [...reorder.filter((id) => ids.has(id)), ...state.servers.map((s) => s.id).filter((id) => !reorder.includes(id))];
    const byId = new Map(state.servers.map((s) => [s.id, s]));
    setHtml($("#world-list"), reorder.map((id, i) => editRow(byId.get(id), i, reorder.length)).join(""));
    renderTotal();
    return renderJobs();
  }
  setHtml($("#world-list"), state.servers.map((s) => {
    const count = s.status === "online" ? (s.players ?? 0)
      : BUSY.has(s.status) ? "..." : s.status === "failed" ? "CRASH" : "OFF";
    return `
    <button type="button" class="world-row ${offline(s) ? "is-offline" : ""} ${BUSY.has(s.status) ? "is-busy" : ""}" data-id="${esc(s.id)}"
      ${s.id === selected ? 'aria-current="true"' : ""}>
      ${worldIcon(s.world)}
      <span class="num">${s.world.number}</span>
      <span class="count">${count}</span>
      <span class="activity">${esc(shortType(s.world))}</span>
    </button>`;
  }).join("") + creatingRows() || `<p class="rs" style="margin:6px;color:#e8dcc0">No worlds yet. Create one.</p>`);

  renderTotal();
  renderJobs();
}

function renderTotal() {
  const online = state.servers.filter((s) => s.status === "online");
  const players = online.reduce((n, s) => n + (s.players ?? 0), 0);
  setHtml($("#total"), `<span><b>${players}</b> ${players === 1 ? "player" : "players"} online</span><span><b>${online.length}</b> of ${state.servers.length} worlds up</span>`);
}

/** Edit's Save: saves the order, if it changed, and leaves Edit mode. */
async function saveOrder() {
  if (reorder.some((id, i) => state.servers.find((s) => s.id === id).world.number !== i + 1)) {
    try { await post("/api/order", { ids: reorder }); }
    catch (err) { return toast(err.message); }
  }
  reorder = null;
  renderSwitcher();
  renderWorld();
}

// ---- Recent jobs ----

const JOB_ICON = {
  create: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></svg>',
  update: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></svg>',
  fetch: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" /></svg>',
  crash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3zM12 10v4M12 17h.01" /></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>',
};
let jobShown = null; // the job whose output the Details dialog shows, so it follows the job live

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** One plain sentence for a job card: what it's doing, what happened, or what went wrong. */
function jobHeadline(t) {
  const world = /World \d+/.exec(t.title ?? "")?.[0] ?? "the world";
  if (t.state === "running") {
    return { fetch: "Checking for updates...", update: `Updating ${world}...`, create: `Creating ${world === "the world" ? "a new world" : world}...`, remove: `Removing ${world}...` }[t.kind] ?? `${t.title}...`;
  }
  if (t.state === "done") return t.summary ?? "Done";
  return { fetch: "Couldn't check for updates", update: `Couldn't update ${world}`, create: "Couldn't create the world", remove: `Couldn't remove ${world}` }[t.kind] ?? `${t.title} didn't work`;
}

/** A job with this key is running (the server hands it back rather than starting a second). */
const jobRunning = (key) => (state.tasks ?? []).some((t) => t.key === key && t.state === "running");

/** The sidebar's Update (git fetch) rests while a check runs, then comes back. */
const COPY = ["Copy", "Copied"];

function renderFetchButton() {
  const checking = jobRunning("fetch") || busy.has("fetch");
  const btn = $("#fetch");
  btn.disabled = checking;
  btn.querySelector(".label").innerHTML = steady(checking ? "Checking..." : "Update", ["Update", "Checking..."]);
}

const CRASH = /stopped unexpectedly|Gave up/;

/** A world's crash note, as a red card in the notifications. It stays until the world is back online or Clear. */
function crashCards() {
  return (state.servers ?? []).filter((s) => s.note && CRASH.test(s.note) && !(s.retryAt > Date.now())).map((s) => ({
    id: `crash-${s.id}`, kind: "crash", state: "failed", at: s.lastExit?.at ?? Date.now(), lines: [],
    summary: /^The game/.test(s.note) ? s.note.replace(/^The game/, `World ${s.world.number}`) : `World ${s.world.number}: ${s.note}`,
  }));
}

function renderJobs() {
  renderFetchButton();
  // Finished jobs drop off after 10 seconds (the page redraws on every 3 s poll); failed ones stay until Clear.
  // Newest last: the list sits at the foot of the sidebar and fills from the bottom up.
  notes = notes.filter((t) => Date.now() - t.at < 10_000);
  const jobs = [...notes, ...crashCards(), ...(state.tasks ?? [])].sort((a, b) => b.at - a.at)
    .filter((t) => t.state !== "done" || Date.now() - (t.endedAt ?? t.at) < 10_000).slice(0, 6).reverse();
  $("#jobs-wrap").hidden = jobs.length === 0;
  $("#jobs-clear").hidden = !jobs.some((t) => t.state !== "running");
  // Details sits on the time line, so the sentence gets the card's full width; it opens the output in a dialog.
  setHtml($("#jobs"), jobs.map((t) => `
    <article class="job j-${esc(t.state)} k-${esc(t.kind ?? "job")}" data-id="${esc(t.id)}">
      <span class="job-icon">${JOB_ICON[t.kind] ?? JOB_ICON.fetch}</span>
      <div class="job-body">
        <div class="job-title">${esc(jobHeadline(t)).replace(/World \d+/, '<b class="job-world">$&</b>')}</div>
        <div class="job-when"><span>${t.state === "running" ? clock(Date.now() - t.at) : ago(t.endedAt ?? t.at)}</span>
          ${t.lines.length && !(t.quiet && t.state === "done") ? `<button type="button" class="addr-btn job-more" data-job="${esc(t.id)}" aria-label="Details of ${esc(t.title ?? "this job")}">Details</button>` : ""}</div>
      </div>
    </article>`).join(""));
  if (jobShown) showJob(jobShown);
}

const jobLog = (t) => t.lines.filter((l, i, a) => l || a[i - 1]).join("\n");

/** Fills the Details dialog for job `id`, keeping it scrolled to the end if it was there. */
function showJob(id) {
  const t = (state.tasks ?? []).find((x) => x.id === id);
  if (!t) return;
  // The card's sentence as the title; for a failure, the reason the output gives under it.
  $("#job-title").textContent = jobHeadline(t);
  $("#job-summary").textContent = t.state === "running" ? clock(Date.now() - t.at) : t.state === "failed" ? t.summary ?? "" : "";
  $("#job-summary").className = `job-summary ${t.state}`;
  const pre = $("#job-log");
  const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  const text = jobLog(t) || "No output.";
  if (pre.textContent !== text) {
    pre.textContent = text;
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }
}

$("#jobs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-job]");
  if (!btn) return;
  jobShown = btn.dataset.job;
  $("#job-log").textContent = "";
  showJob(jobShown);
  $("#job-dialog").showModal();
  $("#job-log").scrollTop = $("#job-log").scrollHeight;
});
$("#job-dialog").addEventListener("close", () => { jobShown = null; });
$("#jobs-clear").onclick = () => (notes = [], post("/api/tasks/clear").catch((err) => toast(err.message)));
setInterval(() => { if (state.tasks?.length) renderJobs(); }, 1000);

// ---- selected world ----

/** One Connection row: what it is, the address (a link when it opens in a browser), and Copy. */
function address(label, value, { href = null } = {}) {
  const shown = esc(value.replace(/^https?:\/\//, ""));
  return `
    <li class="address">
      <span class="addr-label">${esc(label)}</span>
      ${href ? `<a class="addr-value link" href="${esc(href)}" target="_blank" rel="noopener">${shown}</a>` : `<span class="addr-value">${shown}</span>`}
      <button type="button" class="addr-btn" data-copy="${esc(value)}" aria-label="Copy ${esc(label)} address">${steady("Copy", COPY)}</button>
    </li>`;
}

function heroActions(s) {
  const b = (a) => (busy.has(`${s.id}:${a}`) ? "disabled" : "");
  const n = s.world.number;
  const stopping = s.status === "stopping";
  const play = running(s) && s.status === "online"
    ? `<a class="play" href="${esc(s.links.client)}" target="_blank" rel="noopener"><span class="play-orb">${ICON.play}</span>Play World ${n}</a>`
    : `<span class="play off" aria-disabled="true"><span class="play-orb">${ICON.play}</span>Play World ${n}</span>`;

  // Three buttons of one size under Play, always in the same places: power, restart, settings.
  // One that can't be used now stays, greyed.
  const off = (icon, label) => `<button type="button" class="stone" disabled>${icon}${label}</button>`;
  const shutDown = () => `<button type="button" class="stone red" ${stopping ? "disabled" : b("stop")} data-act="stop" data-confirm="stop">${ICON.power}${stopping ? "Stopping" : "Shut down"}</button>`;
  const gameDown = running(s) && (s.status === "game-stopped" || s.status === "failed");

  let first;
  let second;
  if (!running(s)) {
    first = `<button type="button" class="stone gold" ${b("start")} data-act="start">${ICON.power}Launch</button>`;
    second = off(ICON.restart, "Restart");
  } else if (gameDown) {
    // The process is up but the game isn't: start the game, or shut the whole world down.
    first = `<button type="button" class="stone gold" ${b("game-start")} data-act="game-start">${ICON.power}Start</button>`;
    second = shutDown();
  } else {
    first = shutDown();
    const act = s.managed ? "restart" : "game-restart";
    second = stopping || !(s.managed || s.panelUp)
      ? off(ICON.restart, "Restart")
      : `<button type="button" class="stone" ${b(act)} data-act="${act}" data-confirm="restart">${ICON.restart}Restart</button>`;
  }
  const settings = s.links.worldAdmin && s.panelUp
    ? `<a class="stone" href="${esc(s.links.worldAdmin)}" target="_blank" rel="noopener">${ICON.settings}Settings</a>`
    : off(ICON.settings, "Settings");
  // While the world goes down or comes back, its progress tile takes Play's place (Play can't be used then anyway).
  return `${transitionBanner(s) || play}<div class="world-buttons">${first}${second}${settings}</div>`;
}

/**
 * While the world goes down or comes back, this takes the Play button's place, at its size, so the
 * page never grows: the in-game update countdown ("System update in 0:47"),
 * a shutdown, restart or launch with a running clock and the step it's on, or the wait before an
 * automatic restart after a crash.
 */
function transitionBanner(s) {
  const n = s.world.number;
  const tile = ({ icon, kind, title, line, extra = "" }) => `
    <div class="transit osrs ${kind}" role="status">
      <span class="orb">${icon}</span>
      <div class="tr-text"><div class="v">${title}</div><div class="k">${esc(line)}</div></div>
      ${extra}
    </div>`;

  const cd = s.countdown;
  if (cd && cd.endsAt > Date.now()) {
    return tile({
      icon: ICON.clock, kind: "update",
      title: `System update in <span data-until="${cd.endsAt}"></span>`,
      line: cd.reason === "settings" ? "Applying new world settings" : "Update started in game",
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
    });
  }
  if (s.retryAt && s.retryAt > Date.now()) {
    return tile({
      icon: ICON.restart, kind: "restart",
      title: `Restarting after a crash in <span data-until="${s.retryAt}"></span>`,
      line: "Shut down to stop it trying again",
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
  // While the crash restart counts down, its banner already says so.
  const waiting = s.retryAt && s.retryAt > Date.now();
  // A crash note is a card in the notifications instead (crashCards).
  if (s.note && !waiting && !CRASH.test(s.note)) out.push(`<div class="banner warn">${esc(s.note)}</div>`);
  return out.join("");
}

/** The World type dropdown's button, in the world heading. Its list is #type-menu. */
function typePicker(s) {
  const label = `<span class="type-label">${esc(typeName(s.world))}</span>`;
  const xp = `${ICON.xp}<span class="xp-val">x${esc(s.world.xp)} XP</span>`;
  // A panel process older than world types sends none: show the type without the dropdown.
  if (!s.world.types?.length) return `<div class="type-pick"><span class="type-static">${worldIcon(s.world)}${label}</span><span class="fact">${xp}</span></div>`;
  const changing = busy.has(`${s.id}:world-type`) || busy.has(`${s.id}:xp-rate`) || BUSY.has(s.status) || (s.external && !s.panelUp);
  return `
    <div class="type-pick">
      <button type="button" id="type-select" class="type-select" data-type-menu aria-haspopup="listbox" aria-label="World type: ${esc(typeName(s.world))}"
        aria-expanded="${menuFor() === s.id}" aria-controls="type-menu" ${changing ? "disabled" : ""}>
        ${worldIcon(s.world)}${label}<span class="caret" aria-hidden="true"></span>
      </button>
      <button type="button" class="fact xp-btn" data-xp ${changing ? "disabled" : ""} aria-label="XP rate: x${esc(s.world.xp)}. Change it">${xp}<svg class="pencil" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /></svg></button>
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

/** What happens when a world setting changes, for World type and XP rate. */
function changeNote(s) {
  return s.status !== "online" ? "Applies at the next launch."
    : s.players ? "Restarts after a 60-second countdown." : "Restart required.";
}

async function changeWorldType(type) {
  const s = current();
  if (!s) return;
  const label = s.world.types.find((t) => t.id === type)?.label ?? type;
  // Laid out like New world: title, one line, a card showing the change with its world icons, a note.
  const to = { type, typeLabel: label, members: type !== "f2p" };
  const ok = await askConfirm({
    title: "Change the world type?",
    card: `
      <div class="type-change">
        <span class="from">${worldIcon(s.world)}<span>${esc(typeName(s.world))}</span></span>
        <span class="arrow" aria-label="to">&rarr;</span>
        <span class="to">${worldIcon(to)}<span>${esc(label)}</span></span>
      </div>`,
    note: changeNote(s),
    yes: "Change type",
    no: "Cancel",
  });
  if (!ok) return;
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

// ---- XP rate dialog ----

let xpFor = null; // the world the XP dialog is for

/** The typed rate, or null: a number above 0 ("5", "1.5", "x10" all work). */
function xpValue() {
  const v = $("#xp-rate").value.trim().replace(/^x/i, "");
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : null;
}

function updateXp() {
  const n = xpValue();
  const bad = $("#xp-rate").value.trim() !== "" && n === null;
  $("#xp-error").textContent = bad ? "Enter a number above 0, like 1, 1.5 or 10." : "";
  $("#xp-error").hidden = !bad;
  $("#xp-save").disabled = n === null || n === state.servers.find((x) => x.id === xpFor)?.world.xp;
}

function openXp() {
  const s = current();
  if (!s) return;
  xpFor = s.id;
  $("#xp-title").textContent = `Change World ${s.world.number}'s XP rate?`;
  $("#xp-rate").value = String(s.world.xp);
  $("#xp-note").textContent = changeNote(s);
  updateXp();
  $("#xp-dialog").showModal();
  $("#xp-rate").setSelectionRange(99, 99); // caret at the end, nothing highlighted
}

$("#xp-rate").oninput = updateXp;
$("#xp-cancel").onclick = () => $("#xp-dialog").close("cancel");
$("#xp-form").onsubmit = async (e) => {
  e.preventDefault();
  const rate = xpValue();
  const id = xpFor;
  if (rate === null || $("#xp-save").disabled) return;
  $("#xp-dialog").close("ok");
  busy.add(`${id}:xp-rate`);
  renderWorld();
  try {
    const r = await post(`/api/servers/${id}/xp-rate`, { rate });
    if (r.message) toast(r.message, "info");
  } catch (err) {
    toast(err.message);
  } finally {
    busy.delete(`${id}:xp-rate`);
    renderWorld();
  }
};

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

  setHtml(el, `
    <div class="hero osrs">
      <div class="hero-main">
        <div class="hero-name">
          <h1>${steady(`World ${s.world.number}`, state.servers.map((w) => `World ${w.world.number}`))}</h1>
          <span class="state st-${esc(s.status)}" role="status">${steady(STATUS[s.status] ?? s.status, Object.values(STATUS))}</span>
          ${s.external ? `<span class="elsewhere">Running outside this panel</span>` : ""}
          ${s.status === "online" ? `<span class="fact">${ICON.people}${s.players ?? 0} online</span>` : ""}
          ${running(s) && s.startedAt ? `<span class="fact">${ICON.clock}Up <span id="uptime">-</span></span>`
            : !running(s) && lastExit ? `<span class="fact">${ICON.clock}Shut down ${esc(lastExit)}</span>` : ""}
        </div>
        ${typePicker(s)}
        <div class="worldname">${esc(s.world.name)}${s.world.description ? ` <span class="dim">- ${esc(s.world.description)}</span>` : ""}</div>
      </div>
      <div class="hero-actions">${heroActions(s)}</div>
    </div>
    ${banners(s)}
    <div class="world-split">
    <section class="panel osrs world-tabs">
      <div class="tabs" role="tablist" aria-label="World details">
        <button type="button" role="tab" id="tab-update" data-tab="update" aria-controls="tabpanel-update" aria-selected="${worldTab === "update"}" tabindex="${worldTab === "update" ? 0 : -1}">Options</button>
        <button type="button" role="tab" id="tab-connection" data-tab="connection" aria-controls="tabpanel-connection" aria-selected="${worldTab === "connection"}" tabindex="${worldTab === "connection" ? 0 : -1}">Connection</button>
      </div>
      <div class="tabpanels">
        <div role="tabpanel" id="tabpanel-update" aria-labelledby="tab-update" class="tab-col" ${worldTab === "update" ? "" : "data-off"}>
        <div class="options">
          <label class="osrs-check"><input type="checkbox" data-flag="autostart" ${s.autostart ? "checked" : ""}><span class="box" aria-hidden="true"></span><span>Launch when the panel opens</span></label>
          <p class="hint">Starts this world whenever the admin panel starts.</p>
          <label class="osrs-check"><input type="checkbox" data-flag="autorestart" ${s.autorestart ? "checked" : ""}><span class="box" aria-hidden="true"></span><span>Restart after a crash</span></label>
          <p class="hint">Waits 5 s, 15 s, 30 s, 1 min, 2 min, then 5 min; gives up after 6 crashes in 15 minutes.</p>
        </div>
        ${s.main ? "" : `
        <div class="remove-world">
          <button type="button" class="stone red" ${running(s) || b("remove") ? "disabled" : ""} data-remove>${ICON.trash}Remove world</button>
          <p class="hint">Deletes the world and its player saves.</p>
        </div>`}
        </div>
        <div role="tabpanel" id="tabpanel-connection" aria-labelledby="tab-connection" ${worldTab === "connection" ? "" : "data-off"}>
        <ul class="addresses">
          ${address("Game client", s.links.client, { href: running(s) ? s.links.client : null })}
          ${address("Game server", `localhost:${p.game}`)}
          <li class="address">
            <span class="addr-label">Desktop client</span>
            <span class="addr-value">${s.desktop ? "Connects here" : s.desktopPicked ? "Picked; connects here when online" : "Another world"}</span>
            ${s.desktop || s.desktopPicked ? "" : `<button type="button" class="addr-btn" data-act="desktop">Use</button>`}
          </li>
          ${address("Agent MCP", s.links.mcp)}
          ${address("RuneLite gateway", `localhost:${p.gateway}`)}
          <li class="address">
            <span class="addr-label">Folder</span>
            <span class="addr-value">${esc(folderOf(s))}</span>
            <button type="button" class="addr-btn" ${b("open-folder")} data-act="open-folder">Open</button>
          </li>
        </ul>
        </div>
      </div>
    </section>
    <section class="panel osrs update-panel" aria-labelledby="update-title">
            <h3 class="rs-title" id="update-title">Game update</h3>
        ${g ? `
        <dl class="kv">
          <dt>Branch</dt><dd class="y">${esc(g.branch ?? "?")}</dd>
          <dt>Tracking</dt><dd>${esc(g.fork?.parent ? `${g.fork.parent} (via ${g.upstream})` : g.upstream ?? "none")}</dd>
          <dt>Status</dt><dd>${sync}</dd>
          ${g.last ? `<dt>Latest</dt><dd class="latest"><span class="subject">${esc(g.last.subject).replace(/\S+\/\S+/g, '<span class="nowrap">$&</span>')}</span><span class="dim">${esc(g.last.when)} (<a class="dim link" href="https://github.com/${esc(g.fork?.repo ?? "RSPSApp/tsps")}/commit/${esc(g.last.hash)}" target="_blank" rel="noopener">${esc(g.last.hash)}</a>)</span></dd>` : ""}
        </dl>
        ${g.upstream ? (jobRunning(`update:${s.id}`) || busy.has(`${s.id}:pull`)
          ? `<div class="links"><button type="button" class="stone" disabled>${ICON.update}Updating...</button></div>`
          : `<div class="links"><button type="button" class="stone" data-act="pull">${ICON.update}${waiting ? `Update (${waiting} new)` : "Update"}</button></div>`) : ""}`
        : `<p class="rs" style="margin:0;color:#e8dcc0">Loading...</p>`}
    </section>
    </div>`);
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

/** Remove world, asked in the same "Are you sure?" dialog; uncommitted changes must be ticked away first. */
async function openRemove() {
  const s = current();
  if (!s) return;
  const id = s.id;
  // In game terms: which world, what's lost, and (only if there are any) a tick for its unsaved edits.
  const n = (s.git?.changes ?? []).length;
  const card = `<ul class="restart-list"><li>${worldIcon(s.world)}<span class="rl-n">World ${s.world.number}</span>
    <span class="rl-t">${esc(shortType(s.world))}</span><span class="rl-p">${esc(s.world.name)}</span></li></ul>`;
  const ok = await askConfirm({
    title: `Remove World ${s.world.number}?`,
    text: "The world and all its player saves are deleted for good.",
    card,
    note: "You can make it again later with New world; it starts fresh.",
    yes: "Remove world",
    no: "Cancel",
    danger: true,
    check: n ? `Also throw away ${n} unsaved edit${n === 1 ? "" : "s"} to its game files` : null,
  });
  if (ok) act(id, "remove", { body: { discard: n > 0 } });
}

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

const CHAT_ROWS = 2000;
let chatShown = null; // what the console holds: { id, key (filter + search), seen (log lines read) }

/** Whether log line `p` shows under the current tab and search `q`. */
function chatKeeps(p, line, q) {
  if (!p.text.trim()) return false; // the client's build prints spacer lines; they only add gaps
  if (chatFilter === "error" ? !isError(p.text) : chatFilter !== "all" && p.who !== chatFilter) return false;
  return !q || line.toLowerCase().includes(q);
}

// Three columns per line: a dim time, who said it, and the message, whose leading "[cache]"-style
// tags are dimmed so the words after them stand out. Long messages wrap under the message only.
function chatRow(p, t) {
  const kind = p.who === "admin" ? "admin" : isError(p.text) ? "err" : isWarn(p.text) ? "warn" : "";
  const text = esc(p.text.trimEnd()).replace(/^((?:\[[^\]\n]{1,40}\]\s*)+)/, '<span class="tag">$1</span>');
  return `<div class="ln ${kind}"><span class="time">${lineTime(t)}</span>`
    + `<span class="who ${p.who || "other"}">${WHO[p.who] ?? ""}</span><span class="msg">${text}</span></div>`;
}

/** Redraws the whole console: on a world, tab or search change (new lines go through appendChat). */
function renderChat() {
  const body = $("#chat-body");
  chatShown = null;
  if (!selected) { body.innerHTML = ""; return; }
  const all = logLines.get(selected);
  if (!all) { body.innerHTML = `<span class="empty">Loading...</span>`; return; }
  const q = $("#chat-search").value.toLowerCase();
  const rows = [];
  for (const e of all) {
    const p = parse(e.line);
    if (chatKeeps(p, e.line, q)) rows.push(chatRow(p, e.t));
  }
  const s = current();
  if (rows.length === 0) {
    body.innerHTML = `<span class="empty">${q || chatFilter !== "all" ? "Nothing matches." : s?.external
      ? "This world was launched from a terminal; its console output is there."
      : "Welcome to the console. Launch the world to see its messages here."}</span>`;
    return;
  }
  body.innerHTML = rows.slice(-CHAT_ROWS).join("");
  chatShown = { id: selected, key: `${chatFilter}|${q}`, seen: all.length };
  if ($("#chat-follow").checked) body.scrollTop = body.scrollHeight;
}

/** New log lines: adds just their rows (dropping the oldest past CHAT_ROWS) instead of redrawing them all. */
function appendChat() {
  const body = $("#chat-body");
  const all = logLines.get(selected);
  const q = $("#chat-search").value.toLowerCase();
  if (!all || chatShown?.id !== selected || chatShown.key !== `${chatFilter}|${q}` || chatShown.seen < 0) return renderChat();
  const rows = [];
  for (const e of all.slice(chatShown.seen)) {
    const p = parse(e.line);
    if (chatKeeps(p, e.line, q)) rows.push(chatRow(p, e.t));
  }
  chatShown.seen = all.length;
  if (!rows.length) return;
  body.insertAdjacentHTML("beforeend", rows.join(""));
  while (body.childElementCount > CHAT_ROWS) body.firstElementChild.remove();
  if ($("#chat-follow").checked) body.scrollTop = body.scrollHeight;
}

// One formatter for every row: toLocaleTimeString builds a new one per call, which was most of a redraw.
const TIME = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const lineTime = (t) => (t ? TIME.format(t) : "");
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
  if (!row) return;
  if (!reorder) select(row.dataset.id);
});
// Edit mode drag: pointer events, so mouse and touch both work. The list holds the pointer capture,
// since every move redraws the rows under it.
$("#world-list").addEventListener("pointerdown", (e) => {
  const row = reorder && e.button === 0 && e.target.closest(".world-row");
  if (!row) return;
  dragging = row.dataset.id;
  e.currentTarget.setPointerCapture(e.pointerId);
  row.classList.add("is-dragging"); // in place, not a redraw, which would cut off a slide in progress
});
$("#world-list").addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("#world-list .world-row");
  if (over && over.dataset.id !== dragging) moveTo(dragging, reorder.indexOf(over.dataset.id));
});
for (const type of ["pointerup", "pointercancel"]) {
  $("#world-list").addEventListener(type, () => {
    if (!dragging) return;
    dragging = null;
    $("#world-list .is-dragging")?.classList.remove("is-dragging");
  });
}
$("#world-list").addEventListener("keydown", (e) => {
  const row = reorder && e.target.closest(".world-row");
  const d = { ArrowUp: -1, ArrowDown: 1 }[e.key];
  if (!row || !d) return;
  e.preventDefault();
  const id = row.dataset.id;
  const to = reorder.indexOf(id) + d;
  if (to < 0 || to >= reorder.length) return;
  moveTo(id, to);
  $(`#world-list [data-id="${CSS.escape(id)}"]`).focus(); // the redraw replaced the row
});
$("#reorder").onclick = () => { reorder = state.servers.map((s) => s.id); renderSwitcher(); $("#world-list .world-row")?.focus(); };
$("#reorder-cancel").onclick = () => { reorder = null; renderSwitcher(); $("#reorder").focus(); };
$("#reorder-save").onclick = () => saveOrder();
$("#world").addEventListener("click", (e) => {
  if (!selected) return;
  if (e.target.closest("button[data-remove]")) return openRemove();
  if (e.target.closest("button[data-xp]")) return openXp();
  const tab = e.target.closest("[role=tab][data-tab]");
  if (tab) return showTab(tab.dataset.tab);
  if (e.target.closest("button[data-type-menu]")) return menu.hidden ? openTypeMenu(worldTypeMenu()) : closeTypeMenu(true);
  const copy = e.target.closest("button[data-copy]");
  if (copy) {
    return navigator.clipboard.writeText(copy.dataset.copy)
      .then(() => { copy.innerHTML = steady("Copied", COPY); setTimeout(() => (copy.innerHTML = steady("Copy", COPY)), 1500); })
      .catch(() => toast("Couldn't copy; select the address and copy it by hand."));
  }
  // In the TSPS Admin app, Play opens the desktop client on this world; in a browser it opens the web client.
  if (e.target.closest("a.play") && window.__TSPS_ADMIN_APP__) {
    e.preventDefault();
    act(selected, "desktop-play");
    return;
  }
  const btn = e.target.closest("button[data-act]");
  if (btn) {
    const question = QUESTIONS[btn.dataset.confirm];
    act(selected, btn.dataset.act, { ask: question && current() ? question(current()) : null });
  }
});
$("#world").addEventListener("keydown", (e) => {
  // Tabs: left/right (and Home/End) move between them, as a tab list does.
  if (e.target.closest("[role=tab][data-tab]") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
    e.preventDefault();
    const ids = ["update", "connection"];
    const i = ids.indexOf(worldTab);
    showTab({ ArrowLeft: ids[(i + ids.length - 1) % ids.length], ArrowRight: ids[(i + 1) % ids.length], Home: ids[0], End: ids.at(-1) }[e.key]);
    return;
  }
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
let panelRestarting = false; // reload the page once the new panel answers, so it gets the new page too
$("#panel-restart").onclick = async () => {
  const mine = state.servers.filter((s) => s.managed);
  const players = mine.reduce((n, s) => n + (s.players ?? 0), 0);
  // A summary card: one row per world that shuts down (icon, number, type, players).
  const rows = mine.map((s) => `<li>${worldIcon(s.world)}<span class="rl-n">World ${s.world.number}</span>
    <span class="rl-t">${esc(shortType(s.world))}</span><span class="rl-p">${s.status === "online" ? `${s.players ?? 0} online` : esc(STATUS[s.status] ?? s.status)}</span></li>`);
  const ok = await askConfirm({
    title: "Restart the panel?",
    text: !mine.length ? "No worlds are affected." : mine.length === 1 ? "This world will restart:" : "These worlds will restart:",
    card: mine.length ? `<ul class="restart-list">${rows.join("")}</ul>` : "",
    note: players ? `${players} player${players === 1 ? " is" : "s are"} saved first.` : "",
    yes: "Restart panel",
    no: "Cancel",
  });
  if (!ok) return;
  panelRestarting = true;
  $("#panel-restart").disabled = true;
  try { await post("/api/panel/restart"); toast("Restarting the panel...", "info"); }
  catch (err) { panelRestarting = false; $("#panel-restart").disabled = false; toast(err.message); }
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

/** What `scripts/wt new` will make: the next number at the bottom of the list, and the folder beside the main checkout. */
function newWorldPlan(branch) {
  const main = (state.repo ?? "tsps").split(/[\\/]/).pop();
  return { number: state.servers.length + 1, folder: `${main}-${branch.replace(/\//g, "-")}` };
}

let pendingWorld = null; // { folder, number, task } until the new world shows up in the list
let newType = "members";

/** A new world starts from main, so it offers the main checkout's types. */
function newWorldTypes() {
  return state.types
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
  es.onopen = () => { if (panelRestarting) location.reload(); conn.className = "conn live"; conn.textContent = "Live"; };
  es.onerror = () => { conn.className = "conn down"; conn.textContent = "Reconnecting"; };
  es.addEventListener("state", (e) => {
    state = JSON.parse(e.data);
    // A worktree without a port slot is a world still being created (wt new writes the slot last).
    // The server leaves those out; this also covers a panel process from before it did, which would
    // list one as a second World 1 on the main checkout's ports.
    state.servers = state.servers.filter((s) => s.main || s.ports?.slot != null);
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
    if (arr.length > 3000) {
      const cut = arr.length - 3000;
      arr.splice(0, cut);
      if (chatShown?.id === id) chatShown.seen -= cut; // the console's place in the list moves with it
    }
    if (id === selected && !chatQueued) { chatQueued = true; requestAnimationFrame(() => { chatQueued = false; appendChat(); }); }
  });
}
connect();
setInterval(() => { tickUptime(); tickTimers(); }, 1000);
