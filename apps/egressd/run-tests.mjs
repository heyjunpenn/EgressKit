import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const testFiles = readdirSync("src")
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => `src/${file}`);

for (const testFile of testFiles) {
  process.stdout.write(`\nRunning ${testFile}\n`);
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", testFile], {
    stdio: "inherit",
    timeout: 30_000,
  });
  if (result.error?.code === "ETIMEDOUT") {
    process.stderr.write(`${testFile} exceeded the 30 second test-file timeout\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
