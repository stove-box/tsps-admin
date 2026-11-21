// Builds the desktop apps: `node build.mjs [worlds|admin]` (both when omitted).
//
// TSPS Admin's installer also installs the TSPS client: RSPSApp/tsps-desktop-client, cloned into
// .desktop-client/ and built unmodified with client/world.json for this machine's operating system.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_REPO = "https://github.com/RSPSApp/tsps-desktop-client.git";
const clientDir = resolve(here, ".desktop-client");
const apps = process.argv[2] ? [process.argv[2]] : ["worlds", "admin"];

function run(command, args, cwd, env = process.env) {
    const result = spawnSync(command, args, { cwd, stdio: "inherit", env, shell: process.platform === "win32" && command === "npm" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

/** Builds the client from upstream's latest main, then puts its installer where TSPS Admin bundles it. */
function buildClient() {
    if (existsSync(join(clientDir, ".git"))) {
        run("git", ["fetch", "--quiet", "origin"], clientDir);
        run("git", ["reset", "--quiet", "--hard", "origin/main"], clientDir);
    } else {
        run("git", ["clone", "--quiet", CLIENT_REPO, clientDir], here);
    }
    run("npm", ["ci", "--no-audit", "--no-fund"], clientDir);
    // Its own build folder: launcher/.cargo would otherwise put it beside the TSPS apps' installers.
    run("npm", ["run", "build", "--", resolve(here, "client", "world.json")], clientDir,
        { ...process.env, CARGO_TARGET_DIR: join(clientDir, "src-tauri", "target") });
    // Its build regenerates a few vendored files; put them back so the checkout stays upstream's.
    run("git", ["checkout", "--quiet", "--", "."], clientDir);
    if (process.platform !== "win32") {
        throw new Error("Bundling the client into TSPS Admin is only set up for Windows so far.");
    }
    const bundle = join(clientDir, "src-tauri", "target", "release", "bundle", "nsis");
    const setup = readdirSync(bundle).find((file) => file.endsWith("-setup.exe"));
    if (!setup) throw new Error(`No client installer in ${bundle}`);
    const resources = resolve(here, "admin", "src-tauri", "resources");
    mkdirSync(resources, { recursive: true });
    copyFileSync(join(bundle, setup), join(resources, "tsps-client-setup.exe"));
}

for (const app of apps) {
    if (!["worlds", "admin"].includes(app)) throw new Error(`Unknown app: ${app}`);
    if (app === "admin") buildClient();
    // The apps start the panel with this node, so they don't depend on PATH when opened from the Start menu.
    run(process.execPath, [resolve(here, "node_modules/@tauri-apps/cli/tauri.js"), "build"],
        resolve(here, app), { ...process.env, TSPS_NODE: process.execPath });
}
