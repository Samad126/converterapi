#!/usr/bin/env node
// PostToolUse: after a .ts/.tsx edit, typecheck; exit 2 feeds errors back to Claude.
import { spawnSync } from "node:child_process";
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const path = JSON.parse(raw).tool_input?.file_path ?? "";
  if (!/\.(ts|tsx|mts)$/.test(path)) process.exit(0);
  const r = spawnSync("npx", ["tsc", "--noEmit"], { encoding: "utf8", cwd: process.env.CLAUDE_PROJECT_DIR });
  if (r.status !== 0) {
    console.error((r.stdout + r.stderr).split("\n").slice(0, 30).join("\n"));
    process.exit(2);
  }
});
