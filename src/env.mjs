import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

// Keys a tsps server reads its ports and identity from. `scripts/run-with-env.mjs` lets the
// inherited environment win over `.env`, so these must never leak from the panel into a child:
// every worktree would then start on the same ports.
export const SERVER_ENV_KEYS = [
  "WT_SLOT",
  "PORT",
  "WEBSOCKET_PORT",
  "AGENT_MCP_PORT",
  "GATEWAY_PORT",
  "WORLD_ADMIN_PORT",
  "WORLD_ADMIN_TOKEN",
  "BROWSER",
  "REACT_APP_DEFAULT_WS_URL",
  "REACT_APP_DEFAULT_SERVER_ADDRESS",
  "REACT_APP_DEFAULT_SERVER_NAME",
];

export function readEnvFile(file) {
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** The environment the worktree's game server sees: root `.env`, then `server/.env`. */
export function worktreeEnv(dir) {
  return { ...readEnvFile(join(dir, ".env")), ...readEnvFile(join(dir, "server", ".env")) };
}

const port = (value) => {
  const n = Number(value);
  return value !== undefined && String(value).trim() !== "" && Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
};

/** Ports as docs/worktrees.md lays them out: the main checkout has defaults, slot N offsets. */
export function portsFor(env) {
  const raw = Number(env.WT_SLOT);
  const slot = Number.isInteger(raw) && raw >= 1 && raw <= 99 ? raw : null;
  return {
    slot,
    client: port(env.PORT) ?? (slot ? 3100 + slot : 3000),
    game: port(env.WEBSOCKET_PORT) ?? (slot ? 43700 + slot : 43594),
    mcp: port(env.AGENT_MCP_PORT) ?? (slot ? 49800 + slot : 49700),
    gateway: port(env.GATEWAY_PORT) ?? (slot ? 43900 + slot : 43595),
    worldAdmin: port(env.WORLD_ADMIN_PORT) ?? (slot ? 49600 + slot : 49600),
  };
}

/** WORLD_ADMIN_TOKEN from `.env`, else the token the server saved on its first start. */
export function worldAdminToken(dir, env) {
  if (env.WORLD_ADMIN_TOKEN) return String(env.WORLD_ADMIN_TOKEN);
  try {
    const token = readFileSync(join(dir, "server", "data", "definitions", "world-admin.token"), "utf8").trim();
    return /^[A-Za-z0-9_-]{24,}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** The panel's environment minus every key the child must read from its own `.env`. */
export function childEnv(base, dir) {
  const env = { ...base };
  const own = worktreeEnv(dir);
  for (const key of [...SERVER_ENV_KEYS, ...Object.keys(own)]) delete env[key];
  env.BROWSER = own.BROWSER ?? "none";
  env.FORCE_COLOR = "0";
  return env;
}
