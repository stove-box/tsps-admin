# TSPS | Server Admin Panel

One page to run every tsps game world on this PC. Each copy of the game (the main one and any you
make with **+**) shows up as a numbered world in a World Switcher, like the one in Old School RuneScape.
From there you can launch worlds, play them, change their type and XP rate, update them, and watch
their console.

## Start it

Double-click `start-panel.cmd` (or run `npm start`). It prints a link like
`http://localhost:47100/?token=…`. Open it once and the panel remembers you; after that,
`http://localhost:47100` is enough.

To have the panel start when you sign in to Windows:

```
powershell -File scripts/install-startup.ps1          # -Remove to undo
```

You need [Node](https://nodejs.org) 22.16 or newer and Git for Windows. Updating a world from your
fork also needs the GitHub CLI (`gh`), signed in.

## Using it

**World Switcher (left).** Click a world to open it. **+** makes a new world from the latest
RSPSApp/tsps code. The arrows button lets you drag worlds into a new order (✓ saves, ✕ cancels);
this only changes their numbers, so nothing restarts.

**A world (right).**
- **Play** opens the game. **Launch**, **Shut down** and **Restart** do what they say. Players are
  always saved before a world stops.
- The **world type** dropdown (Members, Free-to-play, Hardcore, Leagues) and the **XP rate** button
  change the world. If it's online, it restarts to apply them, with a 60-second countdown when
  players are on. If it's offline, the change applies at the next launch.
- **Options & Updates:** start the world with the panel, restart it after a crash, pull the latest
  code, or remove the world (its folder and player saves are deleted).
- **Connection:** the addresses for the game client, server, Agent MCP and RuneLite gateway.
- **Console:** the world's live output, with filters for Game, Client, Panel and Errors, and a search
  box.

**Bottom left.** **Restart** restarts the panel itself, and the worlds it started come back with it.
**Update** checks every world for new code. **Recent jobs** shows what's running or just finished.

## Settings

`config.json` holds the defaults. Put your own in `config.local.json` (it isn't committed):

```json
{ "tspsRepo": "../tsps", "port": 47100 }
```

## Keep the link private

The panel only answers on this PC, but anyone with its link can control your worlds. Treat the link
like a password; delete `data/admin.token` to get a new one.

## Credits

The page follows rsps.app/host. World icons are the OSRS wiki's sprites; the RuneScape fonts come from
the tsps client. IBM Plex Sans is under the SIL Open Font License (`public/ibm-plex-license.txt`).

Notes for developers and AI assistants are in [CLAUDE.md](CLAUDE.md).
