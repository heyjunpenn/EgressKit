import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";

import { startEgressd } from "../src/daemon.js";
import {
  ConnectionFaultPlan,
  ManualClock,
  startSimulatedMihomoListener,
  startTargetServer,
} from "./support/harness.js";

test("/live reports Node process liveness without a Mihomo listener", async (t) => {
  const daemon = await startEgressd({ host: "127.0.0.1", port: 0 });
  t.after(() => daemon.close());

  const response = await fetch(`http://${daemon.address.host}:${daemon.address.port}/live`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "live" });
});

test("egressd starts from EGRESSKIT_ configuration and shuts down on SIGTERM", async () => {
  const child = spawn(process.execPath, ["dist/cli.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      EGRESSKIT_HOST: "127.0.0.1",
      EGRESSKIT_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));

  try {
    const line = await new Promise<Buffer>((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `egressd exited before startup (code=${code}, signal=${signal}): ${Buffer.concat(errors).toString()}`,
          ),
        );
      });
    });
    const started = JSON.parse(line.toString()) as {
      event: string;
      host: string;
      port: number;
    };

    assert.equal(started.event, "egressd.started");
    assert.equal(started.host, "127.0.0.1");
    assert.ok(started.port > 0);

    const response = await fetch(`http://${started.host}:${started.port}/live`);
    assert.equal(response.status, 200);

    child.kill("SIGTERM");
    const [exitCode, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    assert.equal(signal, null);
    assert.equal(exitCode, 0, Buffer.concat(errors).toString());
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

test("an HTTP proxy request reaches the target through the simulated Mihomo listener", async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const mihomo = await startSimulatedMihomoListener();
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
  });
  t.after(() => daemon.close());

  const targetUrl = `http://${target.host}:${target.port}/observed?through=egresskit`;
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const proxyRequest = request(
      {
        host: daemon.address.host,
        method: "GET",
        path: targetUrl,
        port: daemon.address.port,
      },
      (proxyResponse) => {
        const chunks: Buffer[] = [];
        proxyResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyResponse.on("end", () =>
          resolve({
            status: proxyResponse.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    proxyRequest.on("error", reject);
    proxyRequest.end();
  });

  assert.equal(response.status, 200);
  assert.equal(observedRequests.length, 1);
  assert.deepEqual(JSON.parse(response.body), observedRequests[0]);
  assert.equal(observedRequests[0]?.url, "/observed?through=egresskit");
  assert.equal(observedRequests[0]?.headers.via, "1.1 egresskit, 1.1 simulated-mihomo");
});

test("the test clock advances without waiting for wall-clock time", () => {
  const clock = new ManualClock(1_000);

  clock.advanceBy(250);

  assert.equal(clock.now(), 1_250);
});

test("a connection failure can be injected before the target is reached", async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const faults = new ConnectionFaultPlan();
  faults.failNext("before-target-connect");
  const mihomo = await startSimulatedMihomoListener(faults);
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
  });
  t.after(() => daemon.close());

  const responseStatus = await new Promise<number>((resolve, reject) => {
    const proxyRequest = request(
      {
        host: daemon.address.host,
        method: "GET",
        path: `http://${target.host}:${target.port}/must-not-arrive`,
        port: daemon.address.port,
      },
      (proxyResponse) => {
        proxyResponse.resume();
        proxyResponse.on("end", () => resolve(proxyResponse.statusCode ?? 0));
      },
    );
    proxyRequest.on("error", reject);
    proxyRequest.end();
  });

  assert.equal(responseStatus, 502);
  assert.equal(observedRequests.length, 0);
});

test("a connection failure can be injected immediately after the target connection", async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const faults = new ConnectionFaultPlan();
  faults.failNext("after-target-connect");
  const mihomo = await startSimulatedMihomoListener(faults);
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
  });
  t.after(() => daemon.close());

  const responseStatus = await new Promise<number>((resolve, reject) => {
    const proxyRequest = request(
      {
        host: daemon.address.host,
        method: "GET",
        path: `http://${target.host}:${target.port}/must-not-arrive`,
        port: daemon.address.port,
      },
      (proxyResponse) => {
        proxyResponse.resume();
        proxyResponse.on("end", () => resolve(proxyResponse.statusCode ?? 0));
      },
    );
    proxyRequest.on("error", reject);
    proxyRequest.end();
  });

  assert.equal(responseStatus, 502);
  assert.equal(observedRequests.length, 0);
});
