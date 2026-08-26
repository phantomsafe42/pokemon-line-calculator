import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const testsRoot = path.join(projectRoot, "tests");
const workspaceOnly = new Set([
  "local_testing_state_endpoint.test.mjs",
  "server_projection.test.mjs"
]);
const files = fs.readdirSync(testsRoot)
  .filter(name => name.endsWith(".test.mjs") && !workspaceOnly.has(name))
  .sort()
  .map(name => path.join("tests", name));

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: projectRoot,
  stdio: "inherit",
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
