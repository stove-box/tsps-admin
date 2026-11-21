import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

/** The TSPS desktop client, where its installer (tsps-desktop-client built with world.json) puts it. */
export const DESKTOP_CLIENT = join(process.env.LOCALAPPDATA ?? "", "TSPS Local", "rsps-desktop.exe");

/** Opens the desktop client; it connects through the relay to the world picked last. */
export function openDesktopClient(exe = DESKTOP_CLIENT) {
  if (!existsSync(exe)) throw new Error(`The desktop client isn't installed (${exe}).`);
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
}

/**
 * One fixed address for the TSPS desktop launcher. Every connection (its /api/world-info lookup and
 * the game's WebSocket) is piped as raw TCP to the game port `targetPort()` names at that moment,
 * so the launcher is built once against this address and never changes when worlds do.
 */
export function startDesktopRelay(port, targetPort) {
  const server = net.createServer((client) => {
    const target = targetPort();
    if (!target) return client.destroy();
    const upstream = net.connect(target, "127.0.0.1");
    const end = () => { client.destroy(); upstream.destroy(); };
    for (const socket of [client, upstream]) socket.on("error", end).on("close", end);
    client.pipe(upstream).pipe(client);
  });
  server.on("error", (err) => console.error(`[admin] desktop relay on ${port}: ${err.message}`));
  // Loopback only, like the panel itself.
  server.listen(port, "127.0.0.1", () => console.info(`[admin] desktop client relay on 127.0.0.1:${port}`));
  return server;
}
