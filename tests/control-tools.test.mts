// The tools as a client calls them: through the protocol's tools/call, over the fake AnythingLLM.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Anything } from "../src/control/anything.mts";
import { handle } from "../src/control/mcp.mts";
import { buildServer, CONFIRM_MS, Confirms } from "../src/control/tools.mts";
import { FakeAnythingLLM } from "./fakes/control.mts";

const CHAT = ["chat_workspaces", "chat_list", "chat_history", "chat_new", "chat_rename", "chat_clear", "chat_delete"];
const BOTH = ["chat", "schedule"];
const JOB = { name: "Digest", prompt: "Summarise.", cron: "0 7 * * 1" };

type Result = { content: { text: string }[]; isError?: boolean };

/** Calls a tool as a client would; the result, as the client reads it. */
async function call(server: ReturnType<typeof buildServer>, name: string, args: Record<string, unknown>): Promise<Result> {
  const reply = await handle(server, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  assert.ok(reply && "result" in reply, JSON.stringify(reply));
  return reply.result as Result;
}
const said = (r: Result) => r.content.map((c) => c.text).join("");
/** The confirm a preview gave. */
const confirmOf = (r: Result): string => JSON.parse(said(r)).confirm;

test("a role not asked for has no tools", () => {
  const api = new FakeAnythingLLM().client();
  for (const [roles, names] of [
    [["chat"], CHAT],
    [["schedule"], ["schedule"]],
    [BOTH, [...CHAT, "schedule"]],
  ] as const) {
    const server = buildServer(api, roles, "t");
    assert.deepEqual(
      server.tools.map((t) => t.name),
      names,
    );
    assert.ok(server.tools.every((t) => t.description));
  }
  assert.ok(buildServer(api, BOTH, "t").tools.length <= 10, "under the ten tools AnythingLLM warns about");
});

test("the instructions are the roles' own", () => {
  const api = new FakeAnythingLLM().client();
  assert.match(buildServer(api, ["chat"], "t").instructions, /chat_workspaces/);
  assert.doesNotMatch(buildServer(api, ["chat"], "t").instructions, /Scheduled jobs/);
  assert.match(buildServer(api, BOTH, "t").instructions, /in UTC/);
});

test("a clear is two calls: the first changes nothing and gives the confirm the second needs", async () => {
  const fake = new FakeAnythingLLM();
  const server = buildServer(fake.client(), ["chat"], "t");
  const shown = await call(server, "chat_clear", { workspace: "home", chat: "aaa-1" });
  assert.equal(fake.chats["aaa-1"].length, 2);
  await call(server, "chat_clear", { workspace: "home", chat: "aaa-1", apply: true, confirm: confirmOf(shown) });
  assert.deepEqual(fake.chats["aaa-1"], []);
});

test("an add, an update and a delete are two calls each, and the first changes nothing", async () => {
  const fake = new FakeAnythingLLM();
  const server = buildServer(fake.client(), BOTH, "t");
  for (const args of [{ action: "add", ...JOB }, { action: "update", job: 1, enabled: false }, { action: "delete", job: 1 }]) {
    const shown = await call(server, "schedule", args);
    assert.deepEqual(fake.changes(), [], args.action);
    assert.equal((await call(server, "schedule", { ...args, apply: true, confirm: confirmOf(shown) })).isError, undefined, args.action);
    fake.calls.length = 0;
  }
  assert.deepEqual([...fake.jobs.keys()], [2]);
});

test("apply without the preview's confirm, or with one for other arguments, changes nothing", async () => {
  const fake = new FakeAnythingLLM();
  const server = buildServer(fake.client(), BOTH, "t");
  const other = confirmOf(await call(server, "chat_delete", { workspace: "home", chat: "bbb-2" }));
  const job = confirmOf(await call(server, "schedule", { action: "update", job: 1, enabled: false }));
  for (const [name, args] of [
    ["chat_delete", { workspace: "home", chat: "aaa-1", apply: true }],
    ["chat_delete", { workspace: "home", chat: "aaa-1", apply: true, confirm: "0".repeat(32) }],
    ["chat_delete", { workspace: "home", chat: "aaa-1", apply: true, confirm: other }],
    ["chat_clear", { workspace: "home", chat: "bbb-2", apply: true, confirm: other }],
    ["schedule", { action: "delete", job: 1, apply: true, confirm: job }],
    ["schedule", { action: "add", ...JOB, apply: true }],
  ] as const) {
    const result = await call(server, name, args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(said(result), /apply needs the confirm a call without apply gave, for exactly these arguments/);
  }
  assert.deepEqual(fake.changes(), []);
  assert.equal(fake.jobs.size, 1);
});

test("a confirm is good once, and for ten minutes", async () => {
  const fake = new FakeAnythingLLM();
  let now = 0;
  const server = buildServer(fake.client(), ["schedule"], "t", new Confirms(() => now));
  const add = { action: "add", ...JOB };
  const first = confirmOf(await call(server, "schedule", add));
  assert.equal((await call(server, "schedule", { ...add, apply: true, confirm: first })).isError, undefined);
  assert.equal((await call(server, "schedule", { ...add, apply: true, confirm: first })).isError, true, "used");
  const off = { action: "update", job: 1, enabled: false };
  const late = confirmOf(await call(server, "schedule", off));
  now += CONFIRM_MS;
  assert.equal((await call(server, "schedule", { ...off, apply: true, confirm: late })).isError, true, "late");
  assert.equal(fake.jobs.get(1)?.enabled, true);
  // The arguments a confirm is bound to are compared whatever their order.
  const back = confirmOf(await call(server, "schedule", { enabled: false, job: 1, action: "update" }));
  assert.equal((await call(server, "schedule", { ...off, apply: true, confirm: back })).isError, undefined);
});

test("only the newest hundred confirms are kept", () => {
  const confirms = new Confirms(() => 0);
  const first = confirms.give("chat_delete", { chat: "a" });
  for (let i = 0; i < 100; i++) confirms.give("chat_delete", { chat: `c${i}` });
  assert.throws(() => confirms.take("chat_delete", { chat: "a", confirm: first }), /apply needs the confirm/);
});

test("an answer is the JSON as text", async () => {
  const result = await call(buildServer(new FakeAnythingLLM().client(), ["chat"], "t"), "chat_workspaces", {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(said(result)).workspaces[0], { workspace: "home", name: "Home" });
});

test("an action that lacks what it needs says what", async () => {
  const fake = new FakeAnythingLLM();
  const server = buildServer(fake.client(), ["schedule"], "t");
  for (const [args, lacks] of [
    [{ action: "add", name: "n", prompt: "p" }, "schedule add needs cron"],
    [{ action: "add" }, "schedule add needs name"],
    [{ action: "update", enabled: false }, "schedule update needs job"],
    [{ action: "delete" }, "schedule delete needs job"],
    [{ action: "run" }, "action is one of list, add, update, delete"],
    [{}, "action is required"],
    [{ action: "delete", job: "1" }, "job must be a whole number"],
  ] as const) {
    const result = await call(server, "schedule", args);
    assert.equal(result.isError, true, lacks);
    assert.match(said(result), new RegExp(lacks));
  }
  assert.deepEqual(fake.changes(), []);
});

test("what went wrong reaches the agent in words", async () => {
  const server = buildServer(new FakeAnythingLLM().client(), BOTH, "t");
  for (const [name, args, words] of [
    ["chat_delete", { workspace: "home", chat: "nope" }, /has no chat "nope"/],
    ["chat_list", { workspace: "../x" }, /must be a slug/],
    ["schedule", { action: "add", ...JOB, cron: "daily" }, /cron expression in UTC/],
    ["schedule", { action: "delete", job: 9 }, /Job not found/],
    ["chat_history", { workspace: "home", chat: "aaa-1", last: 2.5 }, /last must be a whole number/],
    ["chat_rename", { workspace: "home", chat: "aaa-1" }, /name is required/],
  ] as const) {
    const result = await call(server, name, args);
    assert.equal(result.isError, true, name);
    assert.match(said(result), words);
  }
});

test("AnythingLLM's refusal is said as it is", async () => {
  const server = buildServer(new Anything(async () => ({ status: 403, json: { error: "forbidden here" } })), ["chat"], "t");
  assert.equal(said(await call(server, "chat_workspaces", {})), "403: forbidden here");
});
