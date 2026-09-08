import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

import { checkMihomoConfig } from "./mihomo-runtime.js";
import { importLocalVlessYaml } from "./subscription.js";

test("official Mihomo checks a private candidate file before it can be applied", async () => {
  const revision = importLocalVlessYaml(
    "proxies:\n  - { name: primary, type: vless, server: node.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n",
    { firstListenerPort: 20_000 },
  );
  let checkedPath: string | undefined;

  await checkMihomoConfig(revision.mihomoConfig, {
    binary: "/opt/mihomo",
    run: async (binary, arguments_) => {
      assert.equal(binary, "/opt/mihomo");
      assert.deepEqual(arguments_.slice(0, 2), ["-t", "-f"]);
      checkedPath = arguments_[2];
      assert.ok(checkedPath);
      const document = parse(await readFile(checkedPath, "utf8"));
      assert.deepEqual(document, revision.mihomoConfig);
    },
  });

  assert.ok(checkedPath);
  await assert.rejects(access(checkedPath));
});

test("official Mihomo check reports a stable error and removes rejected candidate files", async () => {
  const revision = importLocalVlessYaml(
    "proxies:\n  - { name: primary, type: vless, server: secret.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n",
    { firstListenerPort: 20_000 },
  );
  let checkedPath: string | undefined;

  await assert.rejects(
    checkMihomoConfig(revision.mihomoConfig, {
      run: async (_binary, arguments_) => {
        checkedPath = arguments_[2];
        throw new Error("secret.example.com was rejected");
      },
    }),
    /^Error: official Mihomo static check failed$/,
  );

  assert.ok(checkedPath);
  await assert.rejects(access(checkedPath));
});
