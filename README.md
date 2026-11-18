# TSPS | Server Admin Panel

A world management panel for every tsps world on this PC: the main checkout and each `scripts/wt`
worktree, shown as numbered worlds in an Old School RuneScape style World Switcher.

```
start-panel.cmd          # or: npm start
```

The console prints `http://localhost:47100/?token=…`. Open that link once; it sets a cookie and the
panel then works at `http://localhost:47100`. The token is kept in `data/admin.token` (delete it to
get a new one).

## Worlds

Each checkout is a world. Its number is 1 + its `scripts/wt` slot (the main checkout is World 1, slot 1
is World 2, slot 2 is World 3). Name, description, members/free and XP rate come
from its `server/data/definitions/world.json` with `world.local.json` over it (members while the
FreeToPlay plugin is off, as in the server), and from the live world once it's online.

- **Launch world** runs `yarn start` in the worktree. The panel strips `PORT`, `WEBSOCKET_PORT` and the
  other slot keys from the environment it passes on, because `run-with-env.mjs` lets inherited
  variables beat `.env`; each world gets its own ports.
- **Play** opens the world's game client.
- **Shut down** asks the world's settings page (`/api/server/stop`, with its token) to save players
  and stop the game, waits up to 60 s, then ends the process tree (`taskkill /T`). A world launched
  from a terminal is shut down the same way, then the processes listening on its own ports are ended.
- **Restart server** restarts just the game through the world settings page when it's online.
- **Console**: the chatbox keeps the last 3000 lines (tabs for Game, Client, Panel and Errors, search,
  follow); the full log of the current run is in `data/logs/<worktree>.log`, the previous run in
  `.log.1`.
- **Restart after a crash** (per world): after an unexpected exit, or a game crash the world settings
  page reports, it restarts after 5 s, 15 s, 30 s, 1 min, 2 min, 5 min and then gives up until you
  launch it again. The count resets after 15 minutes online.
- **World icons** follow the game's World Switcher (oldschool.runescape.wiki/w/World), using the
  wiki's sprites: the members star (`public/members-world.png`), the free-to-play star
  (`public/free-world.png`), the members star turned green for Leagues, and the Hardcore Worlds icon
  (`public/hardcore-world.png`). The World Switcher's Activity column shows the world type; hover a row
  for its branch.
- **World type** (dropdown in the world heading, each type with its icon): Members, Free-to-play, Hardcore World (on branches that have it) or one of
  the leagues in `plugins/modes/data/leagues.json`. Online, it goes through the world settings page's
  Apply: players are saved (with a 60-second update countdown when anyone is on) and the server
  restarts as the new type. Offline, `world.local.json` is written for the next launch, with the
  server's own rules (no override left behind, free-to-play needs the spawn in an f2p zone).
- **Launch when the panel opens** (per world). To open the panel when you sign in to Windows, run
  `powershell -File scripts/install-startup.ps1` (`-Remove` undoes it).
- **Game update**: branch, upstream, ahead/behind, uncommitted files and last commit. **Check for
  updates** runs `git fetch --all --prune`; **Update** runs `git pull --ff-only`. When the checkout's
  `origin` is a GitHub fork (stove-box/tsps of RSPSApp/tsps) and the world follows the fork's default
  branch, Game update also counts the commits the fork's parent has that it doesn't, and Update first
  syncs the fork on GitHub with `gh repo sync` (fast-forward only, like GitHub's Sync fork), then
  pulls. This needs the GitHub CLI signed in.
- **New world** asks only for a name (made into a branch name as you type: spaces become dashes,
  characters git refuses are dropped), previews the world number, branch and folder it will get, and
  keeps the starting point under Advanced (default `origin/main`). Its World type picker offers the main
  checkout's types; the type is written into the new world's `world.local.json` right after
  `wt new`, so its first launch is already that type. It runs `scripts/wt new <branch>
  [base]` through Git Bash and opens the new world when it appears.
- **Remove world** (foot of the Options panel, shut-down worlds only) runs `scripts/wt rm`. If the worktree has
  uncommitted changes, the dialog lists them and removes it with `git worktree remove --force` only
  after you tick "Discard these changes". The branch is always kept.
- **Ctrl+C** in the panel's console shuts down the worlds it launched (players are saved), then exits.

## Configuration

`config.json` holds the defaults; put overrides in `config.local.json` (gitignored):

```json
{ "tspsRepo": "../tsps", "port": 47100, "bash": "C:/Program Files/Git/bin/bash.exe" }
```

`TSPS_REPO`, `ADMIN_PORT` and `ADMIN_TOKEN` environment variables override these. Options toggled in
the page are saved in `data/settings.json`.

## Security

The panel listens on 127.0.0.1 only and needs its token on every request (cookie or
`Authorization: Bearer`). It accepts only `localhost`/`127.0.0.1` Host headers (against DNS
rebinding), refuses cross-origin writes and requires JSON bodies. It links each world's settings page
with that world's token, so treat the panel link like a password.

## Development

No dependencies; Node 22.16+. `npm test` runs the unit tests.

The page frame (palette, IBM Plex Sans, gold rules) follows rsps.app/host and the server's world
config page; the worlds are drawn with OSRS interface pieces and the RuneScape fonts from the tsps
client (`client/media`). The Plex fonts are under the SIL Open Font License
(`public/ibm-plex-license.txt`).
