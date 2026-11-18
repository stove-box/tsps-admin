import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { childEnv, portsFor, worldAdminToken } from "../src/env.mjs";
import { deriveStatus } from "../src/fleet.mjs";

test("main checkout keeps the default ports", () => {
  assert.deepEqual(portsFor({}), { slot: null, client: 3000, game: 43594, mcp: 49700, gateway: 43595, worldAdmin: 49600 });
});

test("slot N offsets every port, explicit values win", () => {
  assert.deepEqual(portsFor({ WT_SLOT: "5" }), { slot: 5, client: 3105, game: 43705, mcp: 49805, gateway: 43905, worldAdmin: 49605 });
  assert.equal(portsFor({ WT_SLOT: "5", WEBSOCKET_PORT: "44000" }).game, 44000);
  // A worktree slotted before WORLD_ADMIN_PORT existed still gets 49600 + slot.
  assert.equal(portsFor({ WT_SLOT: "3", PORT: "3103" }).worldAdmin, 49603);
});

test("child env never inherits the panel's port settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsps-admin-"));
  writeFileSync(join(dir, ".env"), "WT_SLOT=2\nPORT=3102\nCUSTOM=1\n");
  const env = childEnv({ PATH: "x", PORT: "3000", WEBSOCKET_PORT: "43594", CUSTOM: "panel" }, dir);
  assert.equal(env.PATH, "x");
  assert.equal(env.PORT, undefined);
  assert.equal(env.WEBSOCKET_PORT, undefined);
  assert.equal(env.CUSTOM, undefined, "keys set in the worktree .env come from that file");
  assert.equal(env.BROWSER, "none");
});

test("world admin token: .env first, then the saved file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsps-admin-"));
  assert.equal(worldAdminToken(dir, {}), null);
  mkdirSync(join(dir, "server", "data", "definitions"), { recursive: true });
  writeFileSync(join(dir, "server", "data", "definitions", "world-admin.token"), "a".repeat(32) + "\n");
  assert.equal(worldAdminToken(dir, {}), "a".repeat(32));
  assert.equal(worldAdminToken(dir, { WORLD_ADMIN_TOKEN: "fromenv" }), "fromenv");
});

test("status combines process and probe", () => {
  assert.equal(deriveStatus({ managed: false, probe: { gameUp: false } }), "offline");
  assert.equal(deriveStatus({ managed: true, probe: { gameUp: false } }), "starting");
  assert.equal(deriveStatus({ managed: true, procState: "stopping", probe: { serverStatus: "online" } }), "stopping");
  assert.equal(deriveStatus({ managed: true, probe: { serverStatus: "stopped" } }), "game-stopped");
  assert.equal(deriveStatus({ managed: false, probe: { gameUp: true } }), "online");
  assert.equal(deriveStatus({ managed: false, probe: {}, retryAt: 1 }), "restarting");
});

test("world info: members unless the FreeToPlay plugin is on; local file wins", async () => {
  const { worldInfo } = await import("../src/fleet.mjs");
  const dir = mkdtempSync(join(tmpdir(), "tsps-admin-"));
  const defs = join(dir, "server", "data", "definitions");
  mkdirSync(defs, { recursive: true });
  writeFileSync(join(defs, "world.json"), JSON.stringify({ name: "Old School RuneScape", experienceMultiplier: 1, plugins: {} }));
  const pick = (w) => ({ name: w.name, type: w.type, members: w.members, xp: w.xp });
  assert.deepEqual(pick(worldInfo(dir)), { name: "Old School RuneScape", type: "members", members: true, xp: 1 });
  writeFileSync(join(defs, "world.local.json"), JSON.stringify({ name: "Test", experienceMultiplier: 5, plugins: { FreeToPlay: { enabled: true } } }));
  assert.deepEqual(pick(worldInfo(dir)), { name: "Test", type: "f2p", members: false, xp: 5 });
});

test("world types: read, change and write like the server's world settings page", async () => {
  const wt = await import("../src/worldtype.mjs");
  const shipped = { spawn: { x: 3089, y: 3524, z: 0 }, zones: [{ minX: 3000, maxX: 3100, minY: 3500, maxY: 3600, tags: ["f2p"] }], plugins: {} };
  assert.equal(wt.currentType(wt.merge(shipped, {})), "members");

  let local = wt.applyChanges(shipped, {}, wt.changesFor("league:5", shipped));
  assert.deepEqual(local, { pluginConfig: { "league:type": 5 } }, "no clutter: unset keys stay unset");
  assert.equal(wt.currentType(wt.merge(shipped, local)), "league:5");

  local = wt.applyChanges(shipped, { name: "Mine", ...local }, wt.changesFor("f2p", shipped));
  assert.deepEqual(local, { name: "Mine", plugins: { FreeToPlay: true } }, "other settings are kept; the league is dropped");
  assert.equal(wt.currentType(wt.merge(shipped, local)), "f2p");
  assert.equal(wt.validate(wt.merge(shipped, local)), null);

  const farSpawn = { ...shipped, spawn: { x: 1, y: 1, z: 0 } };
  assert.match(wt.validate(wt.merge(farSpawn, local)), /spawn inside a zone tagged "f2p"/);

  local = wt.applyChanges(shipped, local, wt.changesFor("members", shipped));
  assert.deepEqual(local, { name: "Mine" });

  // world.json that sets a key itself gets an explicit off value instead of a dropped override.
  const shippedHc = { ...shipped, pluginConfig: { "HardcoreWorld:enabled": true } };
  assert.equal(wt.currentType(wt.merge(shippedHc, {})), "hardcore");
  assert.deepEqual(wt.applyChanges(shippedHc, {}, wt.changesFor("members", shippedHc)), { pluginConfig: { "HardcoreWorld:enabled": false } });
});

test("world types offered follow the worktree's own data", async () => {
  const wt = await import("../src/worldtype.mjs");
  const dir = mkdtempSync(join(tmpdir(), "tsps-admin-"));
  const data = join(dir, "server", "plugins", "modes", "data");
  mkdirSync(data, { recursive: true });
  assert.deepEqual(wt.availableTypes(dir).map((t) => t.id), ["members", "f2p"]);
  writeFileSync(join(data, "hardcore-world.json"), "{}");
  writeFileSync(join(data, "leagues.json"), JSON.stringify({ leagues: { 1: { name: "Leagues I - Twisted" }, 5: { name: "Leagues V - Raging Echoes" } } }));
  assert.deepEqual(wt.availableTypes(dir).map((t) => t.id), ["members", "f2p", "hardcore", "league:1", "league:5"]);
});
