import { readFile, writeFile } from "node:fs/promises";

const [, , tag, packagePath] = process.argv;
const match = tag?.match(
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
);

if (!(match && packagePath)) {
  throw new Error("release tag must be a valid v-prefixed semantic version");
}

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
packageJson.version = tag.slice(1);
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
