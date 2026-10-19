// Putting the bridge on this machine.
//
// install     points the bridge at AnythingLLM's storage (its .env holds the password the bridge
//             logs in with), sets BRIDGE_ALLOW to the clients' when none is, and starts it under
//             the user's service manager (service/)
// uninstall   stops it; its settings stay
// health      every check; false when one fails
//
// The storage is the one named, else the one install was last given, else AnythingLLM Desktop's
// when it is there.

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, saveEnv } from "./envfile.mts";
import { invalid } from "./errors.mts";
import { desktopStorage, expandHome, type Place } from "./paths.mts";
import { choose, foreground, managerOf, parseKind, run, type Host, type Manager, type Run } from "./service/index.mts";
import { fileFor, loadSettings, shown, type Settings } from "./settings.mts";
import { request, Upstream } from "./upstream.mts";

/** Where AnythingLLM's image keeps its storage, which Docker users bind-mount. */
const INNER_STORAGE = "/app/server/storage";

/** This machine: its home, environment and OS (a test may say another), and what install needs. */
export interface Ctx extends Place {
  print: (line: string) => void;
  /** The command that serves, for the service to run. */
  command: string[];
  /** What BRIDGE_ALLOW is set to when it is unset (default-allow.txt). */
  defaultAllow: string;
  /** The service manager's commands; the real ones unless a test gives its own. */
  run?: Run;
  /** The user's id (launchd's GUI domain); this process's unless a test gives its own. */
  uid?: number;
  /** How many seconds a started bridge has to answer (60). */
  startWait?: number;
}

export interface Options {
  storage?: string;
  start: boolean;
  /** BRIDGE_SERVICE to save: a manager's name, or "auto" to choose by the OS. */
  service?: string;
}

const hostOf = (ctx: Ctx): Host => ({ ...ctx, run: ctx.run ?? run, uid: ctx.uid ?? process.getuid?.() ?? 0 });

/** The storage to use, or a refusal that says how to find it. */
function storageFor(ctx: Ctx, asked: string | undefined): string {
  const desktop = desktopStorage(ctx);
  const where = asked ? path.resolve(expandHome(asked, ctx.home)) : (loadSettings(ctx).storage ?? (fs.existsSync(desktop) ? desktop : null));
  if (!where) {
    throw invalid(
      `say which AnythingLLM: --storage DIR. For Docker, the folder mounted at ${INNER_STORAGE} (a named volume isn't reachable from here; use a bind mount). AnythingLLM Desktop's would be ${desktop}, and there is none.`,
    );
  }
  if (!fs.existsSync(path.join(where, "anythingllm.db")) && !fs.existsSync(path.join(where, "plugins"))) throw invalid(`${where} doesn't look like AnythingLLM's storage`);
  return where;
}

const statusOf = async (url: string): Promise<number> => {
  try {
    return (await request(url, { timeout: 5_000 })).status;
  } catch {
    return 0;
  }
};

async function waitFor(url: string, seconds = 60): Promise<boolean> {
  for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline; await sleep(500)) {
    if ((await statusOf(url)) === 200) return true;
  }
  return false;
}

export async function install(ctx: Ctx, opts: Options): Promise<void> {
  const service = opts.service === undefined ? undefined : parseKind(opts.service);
  const storage = storageFor(ctx, opts.storage);
  ctx.print(`AnythingLLM's storage: ${storage}`);
  const file = fileFor(ctx);
  const changes: Record<string, string | null> = { ANYTHINGLLM_STORAGE: storage };
  if (service !== undefined) changes.BRIDGE_SERVICE = service || null;
  if (readEnv(file).BRIDGE_ALLOW === undefined) {
    changes.BRIDGE_ALLOW = ctx.defaultAllow;
    ctx.print(`BRIDGE_ALLOW: what its clients call, ${ctx.defaultAllow}`);
  }
  saveEnv(file, changes);
  const settings = loadSettings(ctx);
  if (opts.start) await start(ctx, settings, file);
  leftForYou(ctx, settings, file);
}

async function start(ctx: Ctx, settings: Settings, file: string): Promise<void> {
  const manager = choose(settings.service, hostOf(ctx));
  if (manager === foreground) {
    ctx.print(`${settings.service ? "BRIDGE_SERVICE is foreground" : "This machine has no service manager the bridge drives"}. Run \`anywherellm-bridge serve\``);
    ctx.print("under your own supervisor: a terminal, tmux, a container, a process manager. It reads the same settings file.");
    return;
  }
  if (manager.define({ command: ctx.command, envFile: file, port: settings.port })) ctx.print(`wrote the bridge's service: ${manager.label}`);
  manager.start();
  if (!(await waitFor(`http://127.0.0.1:${settings.port}/health`, ctx.startWait))) throw invalid(`the bridge didn't answer; see ${manager.logs}`);
}

/** The manager the bridge was defined in, if any. */
const definedIn = (ctx: Ctx, settings: Settings): Manager | null => {
  const manager = managerOf(settings.service, hostOf(ctx));
  return manager !== foreground && manager.defined() ? manager : null;
};

/** What install could not do for the owner. */
function leftForYou(ctx: Ctx, settings: Settings, file: string): void {
  ctx.print("\nLeft for you:");
  if (!settings.envFile || !fs.existsSync(settings.envFile)) {
    ctx.print(`- AnythingLLM's .env isn't at ${settings.envFile}: set ANYTHINGLLM_ENV in ${file} (its password is the bridge's login; none is needed for Desktop).`);
  }
  if (!settings.allow.length) ctx.print(`- BRIDGE_ALLOW is empty, so the bridge passes nothing: set it in ${file}.`);
  ctx.print("- For AnywhereLLM Lite: give the bridge an https address (README: Reach it from your devices).");
}

export function uninstall(ctx: Ctx): void {
  const manager = definedIn(ctx, loadSettings(ctx));
  if (!manager) ctx.print("No service of the bridge's is defined: stop `anywherellm-bridge serve` where you run it.");
  else if (manager.stop()) ctx.print("Stopped the bridge.");
  else ctx.print(`${manager.label} would not stop: stop the bridge yourself.`);
  ctx.print(`Its settings stay in ${fileFor(ctx)}.`);
}

type Check = [what: string, ok: boolean, detail: string];

/** Every health check; false when one failed. */
export async function health(ctx: Ctx): Promise<boolean> {
  const settings = loadSettings(ctx);
  const found: Check[] = [];
  const manager = definedIn(ctx, settings);
  if (manager) {
    const state = manager.status();
    found.push([manager.label, state === "active", state]);
  }
  const probe = (what: string, status: number, detail = ""): Check => [what, status === 200, `${detail}${status || "no answer"}`];
  const publicUrl = `${settings.publicUrl}/health`;
  const [bridge, ping, login, route] = await Promise.all([
    statusOf(`http://127.0.0.1:${settings.port}/health`),
    statusOf(`${settings.anythingllmUrl}/api/ping`),
    loginCheck(settings),
    settings.publicUrl ? statusOf(publicUrl).then((status) => probe(publicUrl, status)) : (["route", true, "PUBLIC_URL and PUBLIC_HOST unset: the bridge answers on this machine only"] as Check),
  ]);
  found.push(probe(`bridge on :${settings.port}`, bridge), probe("AnythingLLM", ping, `${settings.anythingllmUrl}: `), login);
  const allowed = shown(settings).BRIDGE_ALLOW;
  found.push(["BRIDGE_ALLOW", Boolean(allowed), allowed || "empty: the bridge passes nothing"], route);
  for (const [what, ok, detail] of found) ctx.print(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  return found.every(([, ok]) => ok);
}

async function loginCheck(settings: Settings): Promise<Check> {
  const name = "the internal API's login";
  try {
    const reply = await Upstream.of(settings).exchange("GET", "/system/api-keys");
    return [name, reply.status !== 401, reply.status === 401 ? "refused" : ""];
  } catch (e) {
    return [name, false, (e as Error).message];
  }
}
