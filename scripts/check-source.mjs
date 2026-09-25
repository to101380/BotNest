import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
let count = 0;
for (const directory of ["public", "functions", "functions/test", "scripts"]) {
  for (const name of await readdir(path.join(root, directory))) {
    if (!/\.(m?js)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ["--check", path.join(root, directory, name)], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status || 1);
    count++;
  }
}
console.log(`Syntax checked ${count} JavaScript files.`);
