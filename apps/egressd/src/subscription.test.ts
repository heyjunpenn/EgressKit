import assert from "node:assert/strict";
import { test } from "node:test";

import { importLocalVlessYaml } from "./subscription.js";

test("imports only normalized VLESS nodes and generates loopback listeners", () => {
  const revision = importLocalVlessYaml(
    `
proxies:
  - name: primary
    type: vless
    server: proxy.example.com
    port: 443
    uuid: 11111111-1111-4111-8111-111111111111
    network: ws
    tls: true
    servername: edge.example.com
    ws-opts:
      path: /gateway
    unknown-secret: must-not-pass-through
  - name: ignored
    type: ss
    server: ignored.example.com
    port: 443
`,
    { firstListenerPort: 20_000 },
  );

  assert.deepEqual(revision, {
    nodes: [
      {
        name: "primary",
        type: "vless",
        server: "proxy.example.com",
        port: 443,
        uuid: "11111111-1111-4111-8111-111111111111",
        network: "ws",
        tls: true,
        servername: "edge.example.com",
        "ws-opts": { path: "/gateway" },
      },
    ],
    mihomoConfig: {
      listeners: [
        {
          name: "egresskit-primary",
          type: "http",
          listen: "127.0.0.1",
          port: 20_000,
          proxy: "primary",
        },
      ],
      proxies: [
        {
          name: "primary",
          type: "vless",
          server: "proxy.example.com",
          port: 443,
          uuid: "11111111-1111-4111-8111-111111111111",
          network: "ws",
          tls: true,
          servername: "edge.example.com",
          "ws-opts": { path: "/gateway" },
        },
      ],
    },
  });
});

test("rejects duplicate VLESS node names", () => {
  assert.throws(
    () =>
      importLocalVlessYaml(
        `proxies:
  - { name: duplicate, type: vless, server: one.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
  - { name: duplicate, type: vless, server: two.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }
`,
        { firstListenerPort: 20_000 },
      ),
    /duplicate VLESS node name: duplicate/,
  );
});

test("rejects a VLESS node with a missing required field", () => {
  assert.throws(
    () =>
      importLocalVlessYaml(
        `proxies:
  - { name: incomplete, type: vless, server: proxy.example.com, port: 443 }
`,
        { firstListenerPort: 20_000 },
      ),
    /missing required field: uuid/,
  );
});

test("rejects an unsupported VLESS transport", () => {
  assert.throws(
    () =>
      importLocalVlessYaml(
        `proxies:
  - { name: unsupported, type: vless, server: proxy.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111, network: h2 }
`,
        { firstListenerPort: 20_000 },
      ),
    /unsupported transport: h2/,
  );
});

test("rejects options that do not belong to the selected transport", () => {
  assert.throws(
    () =>
      importLocalVlessYaml(
        `proxies:
  - name: invalid-combination
    type: vless
    server: proxy.example.com
    port: 443
    uuid: 11111111-1111-4111-8111-111111111111
    network: tcp
    ws-opts: { path: /not-tcp }
`,
        { firstListenerPort: 20_000 },
      ),
    /ws-opts requires the ws transport/,
  );
});
