# tsps-admin: notes for developers and AI assistants

The user-facing guide is README.md. This file keeps the technical detail: how things work and why.

## Shape

- No dependencies, Node 22.16+, ESM. `npm test` runs `test/*.test.mjs` with `node --test`.
- `src/server.mjs`: HTTP server, auth, routes, server-sent events (`/api/events`), quit and restart.
- `src/fleet.mjs`: the worlds (`Fleet`): discovery, probing, start/stop, crash restarts, jobs
  (`task()`), git updates, create/remove worlds, world settings changes.
- `src/env.mjs`: ports and env per worktree. `src/git.mjs`: git helpers. `src/worldtype.mjs`:
  world.json / world.local.json layers, world types, the server's apply rules.
- `public/`: one page (`index.html`, `app.js`, `style.css`), no build step. Static files are read
  per request (no-store), so a page change needs only a browser refresh. Server changes need a
  panel restart.
- The tsps repo is `../tsps` by default (`tspsRepo` in config, or `TSPS_REPO`). `ADMIN_PORT` and
  `ADMIN_TOKEN` override the port and token. Page toggles, the world order and the restart resume list
  live in `data/settings.json`.

## Worlds

- A world is the main checkout or a `scripts/wt` worktree. A worktree counts only once `wt new` has
  written its `WT_SLOT` (written last), so a half-made world never shows as a second World 1.
- Ports come from the slot (`env.mjs` `portsFor`); the main checkout keeps the defaults.
- World numbers are display only: the saved order (`settings.order`, folder keys), then the main
  checkout, then creation time. A removal closes the gap.
- Name, description, type and XP come from `server/data/definitions/world.json` with
  `world.local.json` over it (members unless the FreeToPlay plugin is on), and from the live world
  once it's online.
- Launch runs `yarn start` in the worktree. `childEnv` strips `PORT`, `WEBSOCKET_PORT` and the other
  slot keys from the inherited env, because `run-with-env.mjs` lets inherited variables beat `.env`.
- Shut down asks the world settings page (`/api/server/stop`, the world's admin token) to save players,
  waits up to 60 s, then `taskkill /T`. A world launched from a terminal ("Running outside this
  panel") is stopped the same way, then the processes on its own ports are ended.
- Crash restart backoff is 5 s, 15 s, 30 s, 1 min, 2 min, 5 min, then it gives up; the count resets
  after 15 minutes online.
- World type and XP rate share `Fleet.changeWorld`. Online, it goes through the world settings page's
  `/api/apply` (saves players, writes world.local.json, restarts; a 60-second GameUpdate countdown if
  players are on). Offline, world.local.json is written here with the server's rules: a value equal to
  world.json's drops the override, and free-to-play needs the spawn in an f2p zone. The game reads
  XP only at startup, so there is no live change.
- New world: when Start from is empty, the panel fetches `main` from https://github.com/RSPSApp/tsps
  into `refs/remotes/rspsapp/main` (no remote is added), runs `scripts/wt new <branch>
  rspsapp/main` through Git Bash, then sets the branch's upstream to `origin/main` so Update works.
  An existing branch, or a typed Start from, is used as is. The chosen type is written into the new
  world's world.local.json right after.
- Remove world runs `scripts/wt rm`; with uncommitted changes (and the tick) it uses `git worktree
  remove --force`. The branch is always kept.
- Game update: `gitInfo` every 30 s. The sidebar's Update runs `git fetch --all --prune`; a world's
  Update runs `git pull --ff-only`. When `origin` is a GitHub fork (stove-box/tsps of RSPSApp/tsps)
  and the world follows the fork's default branch, it also counts the parent's new commits and
  syncs the fork with `gh repo sync` before pulling.

## Panel lifecycle

- Ctrl+C / SIGTERM: `quit()` closes the server, ends the event streams (and empties `clients`; a
  broadcast to an ended response once crashed the panel mid-shutdown), stops the worlds it launched,
  and exits.
- Restart: the same, but first saves the running worlds to `settings.resume`. It then starts a new
  `node src/server.mjs`, detached with no window, writing its output to `data/panel.log` (rewritten on
  each restart). The new panel's `startOnBoot` starts the resume list once. The page reloads when its
  event stream reconnects.
- Logs: each world's current run is in `data/logs/<worktree>.log`, the previous one in `.log.1`. The
  console keeps 3000 lines per world and shows up to 2000.

## Security

Listens on 127.0.0.1 only. Every request needs the token (cookie `tsps_admin_<port>`, set from
`/?token=`, or `Authorization: Bearer`). Only localhost Host headers are accepted (against DNS
rebinding), cross-origin writes are refused, and bodies must be JSON. The page links each world's
settings page with that world's token, so the panel link is as good as a password.

## Page conventions

- `setHtml` only touches the DOM when the markup changed, so the 3-second poll doesn't eat clicks.
- The console appends new lines (`appendChat`) and only redraws in full (`renderChat`) when the
  world, tab or search changes. A full redraw used to cost about 180 ms per log line. It uses one
  shared `Intl.DateTimeFormat`, and rows have `content-visibility: auto`.
- `steady()` stacks every version of a changing label in one grid cell, so boxes keep their size
  (world heading, status pill, Copy, Update).
- One stone surface for every button; variants only tint, edge or size it.
- `--pad` is the shared inner padding (18px, 16px on narrow screens) that keeps the header, tabs
  window and console text on one left edge. The Options & Updates right column is the header's button
  column (330px + 18px gap).
- No `title` tooltips (removed on request). Icon-only buttons carry an `aria-label`.
- Dialogs go through `askConfirm` (title, optional text, card, note, tick box). World summaries use
  the `.restart-list` card.
- Job cards are one plain sentence (`jobHeadline`) plus the time. Finished jobs leave after 10 s;
  failed ones stay until Clear.

## Testing UI changes without a browser

Headless Edge (`msedge --headless --screenshot`) works against a copy of `public/` with a stubbed
`EventSource`/`fetch` fed from a saved `/api/state`. It never lays out narrower than 492px, so check
phone widths inside a 375px iframe. `--virtual-time-budget` freezes `performance.now()`, so time
code synchronously during load instead. To test server changes, use a copy of the panel on another
port (`config.local.json` with its own `port` and `dataDir`), not the live panel, which runs real
worlds with players.
