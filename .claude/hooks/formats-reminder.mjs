#!/usr/bin/env node
// PostToolUse: formats.ts is the single source of truth; remind what must follow it.
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const path = JSON.parse(raw).tool_input?.file_path ?? "";
  if (!/src\/formats\.ts$/.test(path)) process.exit(0);
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext:
    "formats.ts changed: update ALLOWED_EXTENSIONS count in test/unit/formats.test.ts, the supported-types list in openapi.yaml, the README matrix, then `npm run build` and run `node scripts/gen-file-matrix.mjs` in ../frontend." } }));
});
