// The comparing half of tools/routes: stdin is the image's scan (VERSION, then METHOD /path lines).
// usage: routes.mts <default-allow.txt> <image> [--stamp]
import fs from "node:fs";
import { absentRules, defaultRules, type Declared } from "../src/allow.mts";

const [file, image, ...flags] = process.argv.slice(2);
const STAMP = /^# verified against AnythingLLM (\S+)$/m;

let version = "";
const declared: Declared[] = [];
for (const line of fs.readFileSync(0, "utf8").split("\n")) {
  const [word, path] = line.split(" ");
  if (word === "VERSION") version = path;
  else if (path?.startsWith("/")) declared.push({ method: word, segments: path.replace(/^\/+|\/+$/g, "").split("/") });
}
if (!version || declared.length === 0) {
  console.error("tools/routes: the image gave no routes (did AnythingLLM move /app/server/endpoints?)");
  process.exit(2);
}

const text = fs.readFileSync(file, "utf8");
const rules = defaultRules(text);
const stamped = STAMP.exec(text)?.[1];
if (!stamped) {
  console.error(`tools/routes: ${file} has no "# verified against AnythingLLM <version>" line`);
  process.exit(2);
}

const absent = absentRules(rules, declared);
console.log(`${image} is AnythingLLM ${version}: ${declared.length} routes declared, ${rules.length} rules checked`);
if (absent.length > 0) {
  console.error(`no route is declared under: ${absent.join(", ")}`);
  console.error("a client calling these gets AnythingLLM's 404; see docs/endpoints.md, then change default-allow.txt");
  process.exit(1);
}
if (stamped === version) {
  console.log(`every rule names a declared route; default-allow.txt was verified against ${version}`);
} else if (flags.includes("--stamp")) {
  fs.writeFileSync(file, text.replace(STAMP, `# verified against AnythingLLM ${version}`));
  console.log(`every rule names a declared route; stamped ${version} (was ${stamped})`);
} else {
  console.log(`every rule names a declared route, but the stamp says ${stamped}: run tools/routes --stamp to record ${version}`);
}
