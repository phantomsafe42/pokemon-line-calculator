import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const testsRoot = path.join(projectRoot, "tests");
const files = fs.readdirSync(testsRoot)
  .filter(name => name.endsWith(".test.mjs"))
  .sort()
  .map(name => path.join("tests", name));

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: projectRoot,
  stdio: "inherit",
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
