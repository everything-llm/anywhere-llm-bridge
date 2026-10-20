// The built file, started as AnythingLLM starts it (`node control.cjs`, its environment holding
// AUTH_TOKEN and SERVER_PORT), against the fake behind HTTP with a login: a call crosses real
// stdio and real HTTP. tools/e2e does the same inside the real AnythingLLM's container.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeAnythingLLM, serve } from "./fakes/control.mts";

const bundle = fileURLToPath(new URL("../dist/control.cjs", import.meta.url));

/** Starts the server with `env`, sends `requests` one after another, and gives back each answer. */
async function session(env: Record<string, string>, requests: object[]): Promise<{ id: number; result?: { content: { text: string }[]; tools: { name: string }[] } }[]> {
  const child = spawn(process.execPath, [bundle], { env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const answers = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const found = [];
  try {
    for (const request of requests) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`);
      if (!("id" in request)) continue;
      const next = await answers.next();
      found.push(JSON.parse(next.value as string));
    }
  } finally {
    child.stdin.end();
    child.kill();
  }
  return found;
}

test("the server logs in with AnythingLLM's password and port from its environment", async () => {
  const seen: string[] = [];
  const http = await serve(new FakeAnythingLLM(), "pw", seen);
  try {
    const port = new URL(http.url).port;
    const [init, listed, workspaces, jobs] = await session({ AUTH_TOKEN: "pw", SERVER_PORT: port, ANYTHINGLLM_MCP_ROLES: "chat,schedule" }, [
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
      { id: 3, method: "tools/call", params: { name: "chat_workspaces", arguments: {} } },
      { id: 4, method: "tools/call", params: { name: "schedule", arguments: { action: "list" } } },
    ]);
    assert.equal(init.id, 1);
    assert.ok(["chat_workspaces", "schedule"].every((n) => listed.result?.tools.some((t) => t.name === n)));
    assert.match(workspaces.result?.content[0].text ?? "", /Home/);
    assert.match(jobs.result?.content[0].text ?? "", /Morning news/);
    assert.ok(seen.length && seen.every((h) => h === "Bearer tok"));
  } finally {
    await http.close();
  }
});

test("a wrong password reaches the agent as the login's refusal", async () => {
  const http = await serve(new FakeAnythingLLM(), "pw", []);
  try {
    const [answer] = await session({ AUTH_TOKEN: "wrong", ANYTHINGLLM_URL: http.url }, [{ id: 1, method: "tools/call", params: { name: "chat_workspaces", arguments: {} } }]);
    assert.match(answer.result?.content[0].text ?? "", /refused the login with AUTH_TOKEN, AnythingLLM's password/);
  } finally {
    await http.close();
  }
});

test("a role that does not exist stops the server with the reason", () => {
  const run = spawnSync(process.execPath, [bundle], { env: { SystemRoot: process.env.SystemRoot ?? "", ANYTHINGLLM_MCP_ROLES: "admin" }, encoding: "utf8", input: "" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /one or more of chat, schedule/);
});
