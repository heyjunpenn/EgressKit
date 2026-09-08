import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the Docker release pins and verifies the matching Mihomo asset for both architectures", async () => {
  const dockerfile = await readFile(new URL("docker/Dockerfile", root), "utf8");

  assert.match(dockerfile, /MIHOMO_VERSION=v1\.19\.30/);
  assert.match(dockerfile, /dockerfile:1\.7@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /TARGETARCH/);
  assert.match(dockerfile, /amd64/);
  assert.match(dockerfile, /arm64/);
  assert.match(dockerfile, /db214c7a2517e63c150d123178d16d102e03a241ccdae4e5e07ffbe9cf56c6f9/);
  assert.match(dockerfile, /58896873736d28628f66de3677c8654fa0f180662523148e136cff4f6e890069/);
  assert.match(dockerfile, /sha256sum -c/);
  assert.doesNotMatch(dockerfile, /releases\/latest/);
  assert.doesNotMatch(dockerfile, /apt-get/);
  assert.match(dockerfile, /EGRESSKIT_HOST=0\.0\.0\.0/);
  assert.match(dockerfile, /EXPOSE 8787/);
});

test("the Docker image receives both EgressKit and Mihomo license materials", async () => {
  const dockerfile = await readFile(new URL("docker/Dockerfile", root), "utf8");

  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  assert.match(dockerfile, /COPY licenses\/Mihomo-GPL-3\.0\.txt/);
});
