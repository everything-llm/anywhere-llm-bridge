// The bridge against the real thing, which tools/e2e starts and names in the environment:
//
//   E2E_ALLM_URL, E2E_PASSWORD  AnythingLLM from here, and its password (AUTH_TOKEN)
//   E2E_BRIDGE_URL, E2E_KEY     the bridge `install` set up and `serve` runs, and a developer key
//   E2E_WORKSPACE               the slug of the one workspace AnythingLLM holds
//   E2E_CLI                     the built anywherellm-bridge.cjs, with its settings in the environment
//   E2E_ENGINE, E2E_CONTAINER   podman or docker, and the throwaway AnythingLLM's container
//   E2E_CONTROL                 the control server `install --control` put in, as the container sees it
//
// Also E2E_ALLM_PORT, E2E_BRIDGE_PORT and E2E_STORAGE, for a client's own e2e.
//
// The control server is started as AnythingLLM starts it: `node $E2E_CONTROL` inside the container, with
// the container's environment, so it runs on the image's own Node 18. The throwaway holds no exchanges:
// clearing a chat that has some is covered against the fake, in tests/control-chats.test.mts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { test } from "node:test";
import { Upstream } from "../src/upstream.mts";

const env = (name: string): string => process.env[name] ?? "";
const run = !env("E2E_CONTAINER") ? { skip: "run it through tools/e2e" } : {};

test("the bridge install set up passes what the default list names and nothing else", run, async () => {
  const bridge = env("E2E_BRIDGE_URL");
  const key = { Authorization: `Bearer ${env("E2E_KEY")}` };
  const listed = await fetch(`${bridge}/workspaces`, { headers: key });
  assert.equal(listed.status, 200);
  assert.ok(((await listed.json()) as { workspaces: { slug: string }[] }).workspaces.some((w) => w.slug === env("E2E_WORKSPACE")));
  assert.equal((await fetch(`${bridge}/workspaces`)).status, 401);
  const refused = await fetch(`${bridge}/system/api-keys`, { headers: key }); // every key's secret
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /doesn't pass/);
});

test("health passes for what install set up", run, () => {
  const done = spawnSync(process.execPath, [env("E2E_CLI"), "health"], { encoding: "utf8" });
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /ok +bridge on :/);
  assert.match(done.stdout, /ok +the internal API's login/);
  assert.match(done.stdout, /ok +the control server\nok +the control entry/);
});

type Result = { content: { text: string }[]; isError?: boolean };

/** The control server in the container, as an MCP client: `call` sends a tool call and gives back
 *  (is_error, what the agent reads, as JSON when it is); `applied` shows a change, then makes it. `extra`
 *  adds to the container's environment. */
async function control(roles: string, extra: Record<string, string> = {}) {
  const flags = Object.entries({ ANYTHINGLLM_MCP_ROLES: roles, ...extra }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const child = spawn(env("E2E_ENGINE"), ["exec", "-i", ...flags, env("E2E_CONTAINER"), "node", env("E2E_CONTROL")], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const ask = async (method: string, params: object): Promise<unknown> => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`);
    const reply = JSON.parse((await lines.next()).value as string);
    assert.equal(reply.id, id);
    return reply.result;
  };
  await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<[boolean, any]> => {
    const result = (await ask("tools/call", { name, arguments: args })) as Result;
    const text = result.content.map((c) => c.text).join("");
    return [result.isError === true, result.isError ? { why: text } : JSON.parse(text)];
  };
  return {
    call,
    /** The change shown, then made with the confirm it gave. */
    async applied(name: string, args: Record<string, unknown>): Promise<[boolean, any]> {
      const [isError, shown] = await call(name, args);
      return isError ? [isError, shown] : call(name, { ...args, apply: true, confirm: shown.confirm });
    },
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

/** AnythingLLM's internal API, logged in once as its pages are. */
const upstream = new Upstream(env("E2E_ALLM_URL"), { read: () => env("E2E_PASSWORD"), where: "E2E_PASSWORD" });
/** Its JSON for `path`. */
const allm = async (path: string): Promise<any> => (await upstream.exchange("GET", path, undefined, 120_000)).json;

test("AnythingLLM starts the control server install --control put in, and lists its tools", run, async () => {
  await allm("/mcp-servers/force-reload");
  const { servers } = await allm("/mcp-servers/list");
  const found = servers.find((s: { name: string }) => s.name === "control");
  assert.ok(found?.running, JSON.stringify(found));
  assert.deepEqual(found.tools.map((t: { name: string }) => t.name).sort(), ["chat_clear", "chat_delete", "chat_history", "chat_list", "chat_new", "chat_rename", "chat_workspaces", "schedule"]);
});

test("a chat is found, started, renamed and deleted in the real AnythingLLM", run, async () => {
  const c = await control("chat");
  try {
    const workspace = env("E2E_WORKSPACE");
    const [, found] = await c.call("chat_workspaces");
    assert.deepEqual(
      found.workspaces.find((w: { workspace: string }) => w.workspace === workspace),
      { workspace, name: "E2E Workspace" },
    );
    const [, made] = await c.call("chat_new", { workspace });
    const chat = { workspace, chat: made.chat };
    const listed = async () => (await c.call("chat_list", { workspace }))[1].chats.map((x: { chat: string }) => x.chat);
    assert.ok((await listed()).includes(made.chat));
    assert.deepEqual((await c.call("chat_rename", { ...chat, name: "Lisbon trip" }))[1], { chat: made.chat, name: "Lisbon trip" });
    const [, history] = await c.call("chat_history", chat);
    assert.deepEqual([history.name, history.exchanges, history.shown], ["Lisbon trip", 0, []]);
    const [, cleared] = await c.applied("chat_clear", chat);
    assert.equal(cleared.applied, false);
    assert.match(cleared.note, /already empty/);
    const [, shown] = await c.call("chat_delete", chat);
    assert.equal(shown.applied, false);
    assert.ok((await listed()).includes(made.chat));
    assert.equal((await c.call("chat_delete", { ...chat, apply: true, confirm: shown.confirm }))[1].deleted, true);
    assert.ok(!(await listed()).includes(made.chat));
    const [isError, why] = await c.call("chat_delete", chat);
    assert.ok(isError);
    assert.match(why.why, /has no chat/);
  } finally {
    c.close();
  }
});

test("a job is added, changed and deleted in the real AnythingLLM", run, async () => {
  const c = await control("schedule");
  try {
    const job = { name: "Digest", prompt: "Summarise my week.", cron: "0 7 * * 1" };
    const [, before] = await c.call("schedule", { action: "list" });
    assert.equal(before.timezone, "UTC");
    assert.equal((await c.call("schedule", { action: "add", ...job }))[1].applied, false);
    assert.equal((await c.call("schedule", { action: "list" }))[1].jobs.length, before.jobs.length);
    const [, added] = await c.applied("schedule", { action: "add", ...job });
    const id = added.job.id;
    assert.equal(added.job.schedule, "0 7 * * 1");
    const [again, why] = await c.call("schedule", { action: "add", ...job });
    assert.ok(again);
    assert.match(why.why, /identical job already exists/);
    const off = { action: "update", job: id, enabled: false };
    const [, shown] = await c.call("schedule", off);
    assert.deepEqual(shown.changes.enabled, { from: true, to: false });
    assert.equal((await c.call("schedule", { ...off, apply: true, confirm: shown.confirm }))[1].job.enabled, false);
    const [late, lateWhy] = await c.applied("schedule", { action: "update", job: id, cron: "99 7 * * *" });
    assert.ok(late);
    assert.match(lateWhy.why.toLowerCase(), /cron/);
    assert.equal((await c.applied("schedule", { action: "delete", job: id }))[1].deleted, id);
    assert.ok(!(await c.call("schedule", { action: "list" }))[1].jobs.some((j: { id: number }) => j.id === id));
  } finally {
    c.close();
  }
});

test("a password AnythingLLM refuses, and an AnythingLLM that isn't there, are said so", run, async () => {
  const wrong = await control("chat", { AUTH_TOKEN: "not-the-password" });
  const absent = await control("chat", { SERVER_PORT: "9" });
  try {
    const [refused, why] = await wrong.call("chat_workspaces");
    assert.ok(refused);
    assert.match(why.why, /refused the login with AUTH_TOKEN/);
    assert.doesNotMatch(why.why, /\{"error"/);
    const [gone, whyGone] = await absent.call("chat_workspaces");
    assert.ok(gone);
    assert.match(whyGone.why, /can't be reached/);
  } finally {
    wrong.close();
    absent.close();
  }
});
