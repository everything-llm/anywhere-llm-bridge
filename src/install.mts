// Putting the bridge on this machine.
//
// install     points the bridge at AnythingLLM's storage (its .env holds the password the bridge
//             logs in with), sets BRIDGE_ALLOW to the clients' when none is, and starts it under
//             the user's service manager (service/); with --control, also puts the agent's control
//             server and its entry into the storage (control/install.mts)
// uninstall   stops it, and takes the control server out if it was put in; its settings stay
// health      every check; false when one fails
//
// The storage is the one named, else the one install was last given, else AnythingLLM Desktop's
// when it is there.

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, saveEnv } from "./envfile.mts";
import { invalid } from "./errors.mts";
import * as control from "./control/install.mts";
import { DEFAULT_ROLES, parseRoles } from "./control/settings.mts";
import { desktopStorage, expandHome, INNER_STORAGE, samePath, type Place } from "./paths.mts";
import { choose, foreground, managerOf, parseKind, run, type Host, type Manager, type Run } from "./service/index.mts";
import { fileFor, loadSettings, shown, type Settings } from "./settings.mts";
import { request, Upstream } from "./upstream.mts";

/** One line of `health`: what was checked, whether it holds, and what to say about it. */
export type Check = [what: string, ok: boolean, detail: string];

/** This machine: its home, environment and OS (a test may say another), and what install needs. */
export interface Ctx extends Place {
  print: (line: string) => void;
  /** The command that serves, for the service to run. */
  command: string[];
  /** What BRIDGE_ALLOW is set to when it is unset (default-allow.txt). */
  defaultAllow: string;
  /** The control server's file, as `install --control` writes it (build.mjs inlines it). */
  controlSource: string;
  /** The service manager's commands; the real ones unless a test gives its own. */
  run?: Run;
  /** The user's id (launchd's GUI domain); this process's unless a test gives its own. */
  uid?: number;
  /** How many seconds a started bridge has to answer (60). */
  startWait?: number;
  /** How many seconds health waits for an AnythingLLM that answers nothing yet, as one just
   *  restarted does (30). */
  upWait?: number;
}

export interface Options {
  storage?: string;
  start: boolean;
  /** BRIDGE_SERVICE to save: a manager's name, or "auto" to choose by the OS. */
  service?: string;
  /** Put the control server into the storage too. */
  control?: boolean;
  runtime?: control.Runtime;
  /** Comma-separated, as --roles gives them. */
  roles?: string;
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

const RUNTIMES: control.Runtime[] = ["container", "native"];

/** Puts the control server and its entry into the storage: the runtime and the roles are the ones named,
 *  else those of the entry already there, else native for Desktop's storage and container for any other,
 *  and the chat role. */
function putControl(ctx: Ctx, storage: string, opts: Options): void {
  if (opts.runtime && !RUNTIMES.includes(opts.runtime)) throw invalid(`--runtime is container or native, not ${opts.runtime}`);
  const named = opts.roles === undefined ? undefined : parseRoles(opts.roles, "--roles");
  const was = control.current(storage);
  const runtime = opts.runtime ?? was?.runtime ?? (samePath(ctx.platform, storage, desktopStorage(ctx)) ? "native" : "container");
  const roles = named ?? was?.roles ?? DEFAULT_ROLES;
  ctx.print(`The control server: ${runtime === "container" ? `a container's, seen there as ${INNER_STORAGE}` : "AnythingLLM runs on this machine"}; roles ${roles.join(", ")}`);
  for (const line of control.put(storage, ctx.controlSource, control.entry(runtime, storage, roles, ctx.command[0]))) ctx.print(line);
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
  if (opts.control) putControl(ctx, storage, opts);
  if (opts.start) await start(ctx, settings, file);
  leftForYou(ctx, settings, file, opts.control === true);
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
function leftForYou(ctx: Ctx, settings: Settings, file: string, withControl: boolean): void {
  ctx.print("\nLeft for you:");
  if (withControl) ctx.print(`- In AnythingLLM, Settings > Agent Skills: refresh the MCP servers (or restart AnythingLLM) so it starts \`${control.NAME}\`.`);
  if (!settings.envFile || !fs.existsSync(settings.envFile)) {
    ctx.print(`- AnythingLLM's .env isn't at ${settings.envFile}: set ANYTHINGLLM_ENV in ${file} (its password is the bridge's login; none is needed for Desktop).`);
  }
  if (!settings.allow.length) ctx.print(`- BRIDGE_ALLOW is empty, so the bridge passes nothing: set it in ${file}.`);
  ctx.print("- For AnywhereLLM Lite: give the bridge an https address (README: Reach it from your devices).");
}

export function uninstall(ctx: Ctx): void {
  const settings = loadSettings(ctx);
  if (settings.storage) for (const line of control.take(settings.storage)) ctx.print(line);
  const manager = definedIn(ctx, settings);
  if (!manager) ctx.print("No service of the bridge's is defined: stop `anywherellm-bridge serve` where you run it.");
  else if (manager.stop()) ctx.print("Stopped the bridge.");
  else ctx.print(`${manager.label} would not stop: stop the bridge yourself.`);
  ctx.print(`Its settings stay in ${fileFor(ctx)}.`);
}

/** Every health check; false when one failed. */
export async function health(ctx: Ctx): Promise<boolean> {
  const settings = loadSettings(ctx);
  const found: Check[] = [];
  const manager = definedIn(ctx, settings);
  if (manager) {
    const state = manager.status();
    found.push([manager.label, state === "active", state]);
  }
  const probe = (what: string, status: number, detail = "", none = "no answer"): Check => [what, status === 200, `${detail}${status || none}`];
  // An AnythingLLM restarted a moment ago answers nothing for a few seconds: wait for it, saying
  // so, before it and its login are checked, rather than report it down.
  const pingUrl = `${settings.anythingllmUrl}/api/ping`;
  const upWait = ctx.upWait ?? 30;
  let ping = await statusOf(pingUrl);
  if (!ping) {
    ctx.print(`AnythingLLM isn't answering yet: waiting up to ${upWait} s for it to start`);
    if (await waitFor(pingUrl, upWait)) ping = 200;
  }
  const [bridge, login, route] = await Promise.all([
    statusOf(`http://127.0.0.1:${settings.port}/health`),
    loginCheck(settings),
    settings.publicUrl ? statusOf(`${settings.publicUrl}/health`).then((status) => probe(`${settings.publicUrl}/health`, status)) : (["route", true, "PUBLIC_URL and PUBLIC_HOST unset: the bridge answers on this machine only"] as Check),
  ]);
  if (settings.storage && control.installed(settings.storage)) found.push(...control.checks(settings.storage, ctx.controlSource));
  found.push(probe(`bridge on :${settings.port}`, bridge), probe("AnythingLLM", ping, `${settings.anythingllmUrl}: `, `no answer in ${upWait} s`), login);
  found.push(["BRIDGE_ALLOW", settings.allow.length > 0, shown(settings).BRIDGE_ALLOW || "empty: the bridge passes nothing"], route);
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
