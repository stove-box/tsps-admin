import net from "node:net";

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
