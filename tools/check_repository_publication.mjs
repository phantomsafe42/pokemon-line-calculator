import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const gitRoot = path.join(projectRoot, ".git");
const ignoredDirectoryNames = new Set([".codex-tmp", "dist", "node_modules", ".git"]);
const ignoredFileNames = new Set(["AGENTS.md", "AGENTS.override.md", "MAINTENANCE.md", "SETTLED_HISTORY.md", ".codex-project-root"]);

const forbiddenTrackedPaths = [
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)AGENTS\.override\.md$/i,
  /(^|\/)MAINTENANCE\.md$/i,
  /(^|\/)SETTLED_HISTORY\.md$/i,
  /(^|\/)\.codex(?:-|\/|$)/i,
  /(^|\/)dist\//i,
  /(^|\/)node_modules\//i,
  /(^|\/)src\/integrations\//i,
  /(^|\/)src\/testing\//i,
  /(^|\/)tests\/(?:battle_tracker|local_testing_state_endpoint|server_projection|state_snapshot)\.test\.mjs$/i,
  /\.(?:sav|srm|dsv|nds|gba|gbc|gb|3ds|cia)$/i
];

const forbiddenText = [
  { label: "Windows user path", pattern: /[A-Za-z]:[\\/]Users[\\/]/i },
  { label: "credential-like assignment", pattern: /(?:token|password|secret|api[_-]?key)\s*[:=]\s*["'](?!\$\{)[^"']{8,}["']/i }
];

function candidateFiles() {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && (ignoredDirectoryNames.has(entry.name) || entry.name.startsWith(".codex-"))) continue;
      if (entry.isFile() && (ignoredFileNames.has(entry.name) || entry.name.startsWith(".codex-"))) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(projectRoot, absolute).replaceAll("\\", "/"));
      else throw new Error(`Unsupported repository entry ${absolute}`);
    }
  };
  visit(projectRoot);
  return files.sort();
}

let tracked;
let status;
if (fs.existsSync(gitRoot)) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: projectRoot, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Unable to enumerate tracked files: ${String(result.stderr || result.stdout)}`);
  tracked = result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
  status = "repository-publication-valid";
} else {
  tracked = candidateFiles();
  status = "repository-publication-candidate-valid";
}

for (const relativePath of tracked) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (forbiddenTrackedPaths.some(pattern => pattern.test(normalized))) throw new Error(`Forbidden tracked file: ${normalized}`);
  const absolute = path.join(projectRoot, relativePath);
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  const extension = path.extname(relativePath).toLowerCase();
  if (![".css", ".html", ".js", ".json", ".md", ".mjs", ".txt", ".yml", ".yaml"].includes(extension)) continue;
  const content = fs.readFileSync(absolute, "utf8");
  for (const rule of forbiddenText) {
    if (rule.pattern.test(content)) throw new Error(`${rule.label} found in tracked file ${normalized}`);
  }
}

for (const relativePath of tracked.filter(file => file === "index.html" || file === "styles.css" || file.startsWith("src/") && !file.startsWith("src/generated/"))) {
  const absolute = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolute) || fs.statSync(absolute).size > 2_000_000) continue;
  const content = fs.readFileSync(absolute, "utf8");
  for (const [label, pattern] of [
    ["local integration endpoint", /__stream-tools/i],
    ["local-only build marker", /PLC_LOCAL_ONLY_|plc-build-profile[^>]+local/i],
    ["local feature module", /local_(?:live_edit|battle_tracker|testing_state)|src\/(?:integrations|testing)/i],
  ]) if (pattern.test(content)) throw new Error(`${label} found in public runtime source ${relativePath}`);
}

console.log(JSON.stringify({ status, trackedFilesChecked: tracked.length }, null, 2));
