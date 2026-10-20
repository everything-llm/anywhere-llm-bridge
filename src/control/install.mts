// What `install --control` puts into AnythingLLM's storage folder, where AnythingLLM finds it and
// runs it itself:
//
//   anywherellm-bridge/control.cjs        the control MCP server (src/control), built into the bridge
//   plugins/anythingllm_mcp_servers.json  an entry `control` that starts it with `node`
//
// The entry runs the container's own node on the path the container sees (/app/server/storage), or
// for AnythingLLM Desktop (and one run from source) the node that ran install, on the host's path.
// Every other entry of the servers file stays, and so do the settings AnythingLLM keeps in ours
// (`anythingllm`: suppressed tools, autoStart). Files are written in place, not renamed over, since
// a file in AnythingLLM's storage may belong to its user and group.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sameText } from "../atomic.mts";
import { invalid } from "../errors.mts";
import { INNER_STORAGE } from "../paths.mts";
import { DEFAULT_ROLES, ROLES_ENV } from "./settings.mts";

export type Runtime = "container" | "native";
export type Check = [what: string, ok: boolean, detail: string];
type Obj = Record<string, unknown>;

export const NAME = "control";
/** The folder in the storage that holds the bridge's files, and the server's name in it. */
const DIR = "anywherellm-bridge";
const FILE = "control.cjs";

export const serversFile = (storage: string): string => path.join(storage, "plugins", "anythingllm_mcp_servers.json");
const controlFile = (storage: string): string => path.join(storage, DIR, FILE);

/** The servers-file entry that starts the control server. */
export function entry(runtime: Runtime, storage: string, roles: string[], node: string): Obj {
  const [command, file] = runtime === "container" ? ["node", `${INNER_STORAGE}/${DIR}/${FILE}`] : [node, controlFile(storage)];
  return { command, args: [file], env: { [ROLES_ENV]: roles.join(",") } };
}

/** What an entry `entry` wrote says, the runtime and the roles; null for an entry that isn't ours. */
export function parseEntry(found: unknown): { runtime: Runtime; roles: string[] } | null {
  const { command, args, env } = (found ?? {}) as Obj;
  const words = Array.isArray(args) ? args.map(String) : [];
  const file = (words.at(-1) ?? "").replace(/\\/g, "/");
  if (!file.endsWith(`/${DIR}/${FILE}`)) return null;
  const roles = ((env ?? {}) as Obj)[ROLES_ENV];
  return { runtime: command === "node" && file.startsWith(INNER_STORAGE) ? "container" : "native", roles: typeof roles === "string" ? roles.split(",") : DEFAULT_ROLES };
}

const ours = (found: unknown): boolean => parseEntry(found) !== null;

/** Runs a file operation, saying what to do when the storage isn't the user's to write. */
function writable<T>(file: string, operation: () => T): T {
  try {
    return operation();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw e;
    throw invalid(
      `can't write ${file}: the storage belongs to another user, likely the container's. Run install as that user, or for rootless podman inside \`podman unshare\`, or start the container with --userns=keep-id`,
    );
  }
}

/** Whether `file` holds `text`, or for JSON the same value however it's laid out (AnythingLLM
 *  writes the servers file again when a setting changes). */
function holds(file: string, text: string): boolean {
  if (sameText(file, text)) return true;
  if (!file.endsWith(".json") || !fs.existsSync(file)) return false;
  try {
    return isDeepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(text));
  } catch {
    return false;
  }
}

/** Writes `text` unless the file holds it already (holds); whether it wrote. */
function write(file: string, text: string): boolean {
  if (holds(file, text)) return false;
  writable(file, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  });
  return true;
}

function readServers(file: string): Obj {
  if (!fs.existsSync(file)) return {};
  let found: unknown;
  try {
    found = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
  } catch (e) {
    throw invalid(`${file} isn't JSON (${(e as Error).message}); fix it first`);
  }
  if (!found || typeof found !== "object" || Array.isArray(found)) throw invalid(`${file} doesn't hold a JSON object`);
  return found as Obj;
}

/** The servers a servers file's JSON names. */
const serversIn = (config: Obj): Obj => (config.mcpServers ?? {}) as Obj;

/** What our entry in the servers file says (parseEntry), or null when there is none or no file to read. */
export function current(storage: string): ReturnType<typeof parseEntry> {
  try {
    return parseEntry(serversIn(readServers(serversFile(storage)))[NAME]);
  } catch {
    return null;
  }
}

/** Whether anything of the control server is in the storage: its file or an entry that is ours. */
export const installed = (storage: string): boolean => fs.existsSync(controlFile(storage)) || current(storage) !== null;

/** Sets our entry in the servers file, or with null drops it; what it did. */
export function setEntry(storage: string, wanted: Obj | null): string {
  const file = serversFile(storage);
  const config = readServers(file);
  const servers = { ...serversIn(config) };
  const old = servers[NAME] as Obj | undefined;
  if (old !== undefined && !ours(old)) throw invalid(`${file} has a server named ${NAME} that isn't ours; rename it first`);
  if (!wanted && old === undefined) return `no ${NAME} entry in ${file}`;
  if (wanted) servers[NAME] = old?.anythingllm ? { ...wanted, anythingllm: old.anythingllm } : wanted;
  else delete servers[NAME];
  if (!write(file, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`)) return `unchanged: ${NAME} in ${file}`;
  return `${wanted ? "set" : "dropped"} ${NAME} in ${file}`;
}

/** Puts the control server (`source`, control.cjs's text) and its entry into the storage; what it did. */
export function put(storage: string, source: string, wantedEntry: Obj): string[] {
  const file = controlFile(storage);
  return [write(file, source) ? `wrote the control server: ${file}` : `unchanged: ${file}`, setEntry(storage, wantedEntry)];
}

/** Takes out what `put` put in; what it did. */
export function take(storage: string): string[] {
  const done = current(storage) ? [setEntry(storage, null)] : [];
  const folder = path.dirname(controlFile(storage));
  if (fs.existsSync(controlFile(storage))) {
    writable(folder, () => fs.rmSync(controlFile(storage)));
    done.push(`removed ${controlFile(storage)}`);
  }
  return done;
}

/** Whether what `put` puts there is there and current. */
export function checks(storage: string, source: string): Check[] {
  const file = controlFile(storage);
  const why = !fs.existsSync(file) ? "missing" : sameText(file, source) ? "" : "not this version's";
  let listed: Check;
  try {
    const found = serversIn(readServers(serversFile(storage)))[NAME];
    listed = [`the ${NAME} entry`, found !== undefined && ours(found), found === undefined ? `missing from ${serversFile(storage)}` : ours(found) ? "" : "another server has its name"];
  } catch (e) {
    listed = [`the ${NAME} entry`, false, (e as Error).message];
  }
  return [["the control server", !why, why && `${why}: run install --control again`], listed];
}
