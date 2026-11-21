import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startDesktopRelay } from "../src/desktop-relay.mjs";

const listen = (server) => new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));
const get = (port) => new Promise((done, fail) => http.get({ host: "127.0.0.1", port, path: "/api/world-info", agent: false }, (res) => {
  let body = ""; res.on("data", (d) => body += d).on("end", () => done(body));
}).on("error", fail));

test("the relay forwards each connection to the world picked at that moment", async () => {
  const worlds = [1, 2].map((n) => http.createServer((req, res) => res.end(`world ${n} ${req.url}`)));
  const [a, b] = await Promise.all(worlds.map(listen));
  let target = a;
  const relay = startDesktopRelay(0, () => target);
  await new Promise((done) => relay.once("listening", done));
  const port = relay.address().port;
  try {
    assert.equal(await get(port), "world 1 /api/world-info");
    target = b;
    assert.equal(await get(port), "world 2 /api/world-info");
    target = null;
    await assert.rejects(get(port));
  } finally {
    relay.close();
    for (const w of worlds) w.close();
  }
});
