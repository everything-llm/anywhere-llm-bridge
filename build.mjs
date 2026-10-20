// Builds two files. src/control/main.mts becomes dist/control.cjs, the MCP server AnythingLLM starts
// itself with its own node (the image's, Node 18), so it targets node18. src/main.mts becomes
// dist/anywherellm-bridge.cjs: one file that needs nothing installed beside it, for Node 20.3 or later
// (AbortSignal.any), with control.cjs's text inlined (CONTROL_SOURCE) for `install --control` to
// write. default-allow.txt is inlined too, the one copy of the default BRIDGE_ALLOW.
//
// usage: node build.mjs
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const common = { absWorkingDir: here, bundle: true, platform: "node", format: "cjs", logLevel: "warning" };

const control = path.join(here, "dist", "control.cjs");
await build({ ...common, entryPoints: ["src/control/main.mts"], outfile: control, target: "node18" });
console.log(`built -> ${path.relative(here, control)}`);

const outfile = path.join(here, "dist", "anywherellm-bridge.cjs");
await build({
  ...common,
  entryPoints: ["src/main.mts"],
  outfile,
  target: "node20",
  loader: { ".txt": "text" },
  define: { CONTROL_SOURCE: JSON.stringify(fs.readFileSync(control, "utf8")) },
});
fs.chmodSync(outfile, 0o755);
console.log(`built -> ${path.relative(here, outfile)}`);
