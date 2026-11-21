# TSPS | Server Admin Panel

One page to run every tsps game world on this PC. Each copy of the game (the main one and any you
make with **+**) shows up as a numbered world in a World Switcher, like the one in Old School RuneScape.
From there you can launch worlds, play them, change their type and XP rate, update them, and watch
their console. It runs in your browser, or in its own window with the [desktop apps](#desktop-apps).

## Start it

Open **TSPS Admin** if you've installed the [desktop apps](#desktop-apps). Otherwise double-click
`start-panel.cmd` (or run `npm start`). It prints a link like
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
- **Play** opens the game: the web client in a browser tab, or the TSPS client when you're in the
  TSPS Admin app. **Launch**, **Shut down** and **Restart** do what they say. Players are always
  saved before a world stops.
- The **world type** dropdown (Members, Free-to-play, Hardcore, Leagues) and the **XP rate** button
  change the world. If it's online, it restarts to apply them, with a 60-second countdown when
  players are on. If it's offline, the change applies at the next launch.
- **Options:** start the world with the panel, restart it after a crash, or remove the world (its
  folder and player saves are deleted).
- **Game update** (its own window beside Options): the branch, whether it's up to date, the latest
  change (linked on GitHub), and Update to pull the latest code.
- **Connection:** the addresses for the game client, server, Agent MCP and RuneLite gateway.
  **Desktop client** shows whether the TSPS client connects to this world; **Use** points it here.
- **Console:** the world's live output, with filters for Game, Client, Panel and Errors, and a search
  box.

**Bottom left.** **Restart** restarts the panel itself, and the worlds it started come back with it.
**Update** checks every world for new code. **Recent jobs** shows what's running or just finished.

## Desktop apps

Two apps, each usable on its own. Either one starts the panel in the background if it isn't
running (hidden, logging to `data/panel.log`), so closing a window never stops your worlds.

- **TSPS Admin** shows this panel in its own window, with the panel's top bar as the title bar
  (drag it to move, double-click to maximize). While the panel starts, it shows a loading bar and
  a "Did you know?" tip. The window's **X** hides it to the tray; click the tray icon to bring it
  back. **Quit and stop all worlds…** in the tray menu asks first, then waits until every online
  world has saved and stopped before it closes. **Play** in this window opens the TSPS client on
  that world.
- **TSPS Worlds** lists the worlds; click an online one and the TSPS client opens on it.

The TSPS client is RSPSApp's [tsps-desktop-client](https://github.com/RSPSApp/tsps-desktop-client),
built unmodified with `launcher/client/world.json`. It always connects to the panel's relay
(`127.0.0.1:43580`, setting `desktopPort`), which forwards it to the world you picked. Its game
updates come from RSPSApp as usual.

Build and install them once:

1. In `launcher/`, run `npm install` then `npm run build` (needs git, Rust and the
   [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/); `npm run build:worlds` or
   `build:admin` builds one). Building TSPS Admin first clones the latest tsps-desktop-client into
   `launcher/.desktop-client/` and builds it for this operating system (Windows only for now).
2. Install `TSPS Admin_*-setup.exe` (it installs the TSPS client too) and `TSPS Worlds_*-setup.exe`
   from `launcher/target/release/bundle/nsis/`. They read the panel's address and token from this
   checkout and start it with the node that built them, so build them here.

## Settings

`config.json` holds the defaults. Put your own in `config.local.json` (it isn't committed):

```json
{ "tspsRepo": "../tsps", "port": 47100, "desktopPort": 43580 }
```

`desktopPort` is the TSPS client's relay; if you change it, change `serverUrl` in
`launcher/client/world.json` to match and rebuild TSPS Admin.

## Keep the link private

The panel only answers on this PC, but anyone with its link can control your worlds. Treat the link
like a password; delete `data/admin.token` to get a new one.

## Credits

The page follows rsps.app/host. World icons are the OSRS wiki's sprites; the RuneScape fonts come from
the tsps client. IBM Plex Sans is under the SIL Open Font License (`public/ibm-plex-license.txt`).
A few of TSPS Admin's loading tips are the game's own, from the OSRS wiki's
[Did you know?](https://oldschool.runescape.wiki/w/Did_you_know%3F) page.

Notes for developers and AI assistants are in [CLAUDE.md](CLAUDE.md).
