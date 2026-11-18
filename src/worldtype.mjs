import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// World types are the server's own switches, mutually exclusive as on rsps.app/host ("Choose either a
// League or Hardcore World"):
//   members   - the default
//   f2p       - the FreeToPlay plugin switched on (plugins.FreeToPlay)
//   hardcore  - pluginConfig "HardcoreWorld:enabled": true (plugins/modes/data/hardcore-world.json)
//   league:N  - pluginConfig "league:type": N, one of plugins/modes/data/leagues.json
// They are read from world.json with world.local.json over it, and changed in world.local.json only.

const HARDCORE_KEY = "HardcoreWorld:enabled";
const LEAGUE_KEY = "league:type";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const norm = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
const defs = (dir) => join(dir, "server", "data", "definitions");
const modes = (dir) => join(dir, "server", "plugins", "modes", "data");

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

/** The two layers, plus the local file's raw text so a write can refuse a file that changed meanwhile. */
export function readLayers(dir) {
  const shipped = readJson(join(defs(dir), "world.json")) ?? {};
  const file = join(defs(dir), "world.local.json");
  let raw = null;
  let local = {};
  if (existsSync(file)) {
    raw = readFileSync(file, "utf8");
    local = JSON.parse(raw); // a broken file is the user's to fix; the error says so
    if (!isObject(local)) throw new Error("world.local.json is not a JSON object; fix it by hand first");
  }
  return { shipped, local, raw };
}

/** world.local.json over world.json; plugins and pluginConfig merge key by key, as the server does. */
export function merge(shipped, local) {
  return {
    ...shipped,
    ...local,
    plugins: { ...(isObject(shipped.plugins) ? shipped.plugins : {}), ...(isObject(local.plugins) ? local.plugins : {}) },
    pluginConfig: { ...(isObject(shipped.pluginConfig) ? shipped.pluginConfig : {}), ...(isObject(local.pluginConfig) ? local.pluginConfig : {}) },
  };
}

function freeToPlay(world) {
  let on = false;
  for (const [name, entry] of Object.entries(world.plugins ?? {})) {
    if (norm(name) !== "freetoplay") continue;
    const v = isObject(entry) ? entry.enabled : entry;
    if (typeof v === "boolean") on = v;
  }
  return on;
}

/** The types this worktree's code knows: Hardcore only where hardcore-world.json exists, leagues from its data. */
export function availableTypes(dir) {
  const types = [{ id: "members", label: "Members", group: "Standard" }, { id: "f2p", label: "Free-to-play", group: "Standard" }];
  if (existsSync(join(modes(dir), "hardcore-world.json"))) types.push({ id: "hardcore", label: "Hardcore World", group: "Game modes" });
  const leagues = readJson(join(modes(dir), "leagues.json"))?.leagues ?? {};
  for (const [n, league] of Object.entries(leagues)) {
    if (Number(n) > 0 && typeof league?.name === "string") types.push({ id: `league:${Number(n)}`, label: league.name, group: "Leagues" });
  }
  return types;
}

export function currentType(world) {
  const league = Number(world.pluginConfig?.[LEAGUE_KEY]);
  if (Number.isInteger(league) && league > 0) return `league:${league}`;
  if (world.pluginConfig?.[HARDCORE_KEY] === true) return "hardcore";
  if (freeToPlay(world)) return "f2p";
  return "members";
}

/**
 * The world settings API's `changes` for a type. An "off" value is null (drop the local override) when
 * world.json doesn't set the key, else the explicit off value, so world.local.json gets no clutter.
 */
export function changesFor(type, shipped) {
  const has = (section, key) => isObject(shipped[section]) && key in shipped[section];
  const off = (section, key, value) => (has(section, key) ? value : null);
  const league = /^league:(\d+)$/.exec(type);
  return {
    plugins: { FreeToPlay: type === "f2p" ? true : off("plugins", "FreeToPlay", false) },
    pluginConfig: {
      [HARDCORE_KEY]: type === "hardcore" ? true : off("pluginConfig", HARDCORE_KEY, false),
      [LEAGUE_KEY]: league ? Number(league[1]) : off("pluginConfig", LEAGUE_KEY, 0),
    },
  };
}

/** The server's applySection: null or the shipped value removes the local key; empty sections go. */
export function applyChanges(shipped, local, changes) {
  const next = structuredClone(local);
  for (const section of ["plugins", "pluginConfig"]) {
    const edits = changes[section];
    if (!edits) continue;
    const base = isObject(shipped[section]) ? shipped[section] : {};
    const target = isObject(next[section]) ? { ...next[section] } : {};
    for (const [key, value] of Object.entries(edits)) {
      if (value === null || JSON.stringify(value) === JSON.stringify(base[key])) delete target[key];
      else target[key] = value;
    }
    if (Object.keys(target).length === 0) delete next[section];
    else next[section] = target;
  }
  return next;
}

/** What the server would refuse at start (WorldDefinition.parseWorldDefinition). */
export function validate(world) {
  if (!freeToPlay(world)) return null;
  const s = world.spawn ?? {};
  const inside = (world.zones ?? []).some((z) => Array.isArray(z.tags) && z.tags.includes("f2p") &&
    (z.minX === undefined || (s.x >= z.minX && s.x <= z.maxX && s.y >= z.minY && s.y <= z.maxY)));
  return inside ? null : 'Free-to-play needs the spawn inside a zone tagged "f2p"; change the spawn in World settings first.';
}

/** Writes world.local.json atomically, refusing if it changed since `layers` was read. */
export function writeLocal(dir, layers, next) {
  const file = join(defs(dir), "world.local.json");
  const now = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (now !== layers.raw) throw new Error("world.local.json changed while saving; try again");
  const temp = join(defs(dir), `.world.local.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n");
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}
