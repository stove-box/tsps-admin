# TSPS | Server Admin Panel

One local page to start, stop and watch every tsps server on this PC: the main checkout and each
`scripts/wt` worktree.

```
start-panel.cmd          # or: npm start
```

The console prints `http://localhost:47100/?token=…`. Open that link once; it sets a cookie and the
panel then works at `http://localhost:47100`. The token is kept in `data/admin.token` (delete it to
get a new one).

## What it does

- **Finds the servers** with `git worktree list` on the tsps checkout, and reads each one's ports from
  its `.env` the way `docs/worktrees.md` lays them out (main: 3000/43594/49700/49600, slot N: 3100+N …).
- **Start** runs `yarn start` in the worktree. The panel strips `PORT`, `WEBSOCKET_PORT` and the other
  slot keys from the environment it passes on, because `run-with-env.mjs` lets inherited variables beat
  `.env`; each server gets its own ports.
- **Stop** asks the server's world config page (`/api/server/stop`, with its token) to save players
  and stop the game, waits up to 60 s, then ends the whole process tree (`taskkill /T`).
- **Restart** restarts just the game through the world config page when it's online, else stop + start.
- **Servers started from a terminal** are detected by probing their game and world config ports. The
  panel can stop/start/restart their game through the world config page but leaves the process alone.
- **Logs**: the last 3000 lines per server live in the page (filter, follow); the full log of the
  current run is in `data/logs/<worktree>.log`, the previous run in `.log.1`.
- **Auto-restart** (per server): after an unexpected exit, or a game crash the world config page
  reports, it restarts after 5 s, 15 s, 30 s, 1 min, 2 min, 5 min and then gives up until you start it
  again. The count resets after 15 minutes online.
- **Start with panel** (per server): starts it when the panel starts. To start the panel when you sign
  in to Windows, run `powershell -File scripts/install-startup.ps1` (`-Remove` undoes it).
- **Git**: branch, upstream, ahead/behind, uncommitted file count and last commit per worktree.
  **Fetch** runs `git fetch --all --prune`; **Pull** runs `git pull --ff-only`.
- **New worktree** runs `scripts/wt new <branch> [base]` through Git Bash; **Remove** runs
  `scripts/wt rm`, only for stopped worktrees. Git refuses to remove one with uncommitted changes, and
  the branch is kept.
- **Ctrl+C** in the panel's console stops the servers it started (players are saved), then exits.

## Configuration

`config.json` holds the defaults; put overrides in `config.local.json` (gitignored):

```json
{ "tspsRepo": "../tsps", "port": 47100, "bash": "C:/Program Files/Git/bin/bash.exe" }
```

`TSPS_REPO`, `ADMIN_PORT` and `ADMIN_TOKEN` environment variables override these. Settings toggled in
the page are saved in `data/settings.json`.

## Security

The panel listens on 127.0.0.1 only and needs its token on every request (cookie or
`Authorization: Bearer`). It accepts only `localhost`/`127.0.0.1` Host headers (against DNS
rebinding), refuses cross-origin writes and requires JSON bodies. It shows each server's world config
link with that server's token, so treat the panel link like a password.

## Development

No dependencies; Node 22.16+. `npm test` runs the unit tests.

The page's look (palette, IBM Plex Sans, status pills, server bar) follows the server's world config
page. The Plex fonts are under the SIL Open Font License (`public/ibm-plex-license.txt`).
