import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const roots = ["src", "tests", "tools"];
const files = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(projectRoot, absolute).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (relative.startsWith("src/generated/")) continue;
      visit(absolute);
    } else if (entry.isFile() && /\.(?:js|mjs)$/i.test(entry.name)) {
      files.push(relative);
    }
  }
}

for (const root of roots) visit(path.join(projectRoot, root));
files.sort();

for (const relative of files) {
  const result = spawnSync(process.execPath, ["--check", relative], {
    cwd: projectRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`JavaScript syntax check failed: ${relative}`);
  }
}

console.log(JSON.stringify({ status: "javascript-syntax-valid", files: files.length }, null, 2));
