// Writes runtime-files.json: the list of files under runtime/ that the download copies.
// Run it after changing the runtime folder:  node scripts/runtime-files.mjs
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, "runtime");

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [relative(runtime, path).split("\\").join("/")];
  });
}

const files = walk(runtime).sort();
writeFileSync(join(root, "runtime-files.json"), `${JSON.stringify(files, null, 2)}\n`);
console.log(`runtime-files.json: ${files.length} files`);
