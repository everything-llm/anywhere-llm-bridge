// Builds src/main.mts into dist/anywherellm-bridge.cjs: one file that needs nothing installed beside
// it, for Node 20.3 or later (AbortSignal.any). The extension is fixed (.cjs) so it runs the same
// wherever it is copied to. default-allow.txt is inlined, the one copy of the default BRIDGE_ALLOW.
//
// usage: node build.mjs
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "dist", "anywherellm-bridge.cjs");
await build({
  absWorkingDir: here,
  entryPoints: ["src/main.mts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  loader: { ".txt": "text" },
  logLevel: "warning",
});
fs.chmodSync(outfile, 0o755);
console.log(`built -> ${path.relative(here, outfile)}`);
