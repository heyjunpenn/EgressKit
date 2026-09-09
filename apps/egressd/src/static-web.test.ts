import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startEgressd } from "./daemon.js";

test("serves the web application without intercepting management API routes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-web-"));
  const assets = join(directory, "assets");
  await mkdir(assets);
  await writeFile(join(directory, "index.html"), "<!doctype html><title>EgressKit Console</title>");
  await writeFile(join(assets, "app.js"), "console.log('egresskit')");

  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: false,
    webDirectory: directory,
  });
  t.after(async () => {
    await daemon.close();
    await rm(directory, { force: true, recursive: true });
  });

  const origin = `http://${daemon.address.host}:${daemon.address.port}`;
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await page.text(), /EgressKit Console/);

  const asset = await fetch(`${origin}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.equal(await asset.text(), "console.log('egresskit')");

  const live = await fetch(`${origin}/live`);
  assert.deepEqual(await live.json(), { status: "live" });

  const management = await fetch(`${origin}/console/snapshot`);
  assert.equal(management.status, 401);
  assert.doesNotMatch(await management.text(), /EgressKit Console/);
});

test("web routes use the SPA shell while missing asset files stay missing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-web-spa-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<!doctype html><main>console shell</main>");

  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: false,
    webDirectory: directory,
  });
  t.after(async () => {
    await daemon.close();
    await rm(directory, { force: true, recursive: true });
  });

  const origin = `http://${daemon.address.host}:${daemon.address.port}`;
  const route = await fetch(`${origin}/app/docs`, { headers: { accept: "text/html" } });
  assert.equal(route.status, 200);
  assert.match(await route.text(), /console shell/);

  assert.equal((await fetch(`${origin}/app/docs`, { method: "POST" })).status, 404);

  assert.equal((await fetch(`${origin}/assets/missing.js`)).status, 404);
  assert.equal((await fetch(`${origin}/../package.json`)).status, 404);
});
