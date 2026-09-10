import { readFile, writeFile } from "node:fs/promises";

const [, , tag, packagePath] = process.argv;
const match = tag?.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

if (!(match && packagePath)) {
  throw new Error("release tag must be a valid x.y.z semantic version without a prefix");
}

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
packageJson.version = tag;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
