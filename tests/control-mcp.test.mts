// The protocol itself, with a server of two made-up tools.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ControlError } from "../src/control/anything.mts";
import { handle, serveStdio, VERSIONS, type Server } from "../src/control/mcp.mts";

const logged: string[] = [];
const server: Server = {
  name: "test",
  version: "1.2.3",
  instructions: "Be kind.",
  tools: [
    {
      name: "echo",
      description: "Says it back.",
      inputSchema: { type: "object", properties: { words: { type: "array", items: { type: "string" } } }, required: ["words"] },
      run: async (a) => ({ said: a.words }),
    },
    {
      name: "breaks",
      description: "Fails.",
      inputSchema: { type: "object", properties: { how: { type: "string", enum: ["ours", "other"] } } },
      run: async (a) => {
        throw a.how === "ours" ? new ControlError("in words") : new TypeError("x is undefined");
      },
    },
  ],
};
const ask = (method: string, params?: Record<string, unknown>) => handle(server, { jsonrpc: "2.0", id: 7, method, params }, (l) => logged.push(l));

test("initialize answers with the version asked for when it is one it speaks, else its newest", async () => {
  const reply = await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });
  assert.deepEqual(reply, {
    jsonrpc: "2.0",
    id: 7,
    result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "test", version: "1.2.3" }, instructions: "Be kind." },
  });
  const newer = await ask("initialize", { protocolVersion: "2099-01-01" });
  assert.equal((newer as { result: { protocolVersion: string } }).result.protocolVersion, VERSIONS[0]);
});

test("ping, tools/list, and a notification that gets no answer", async () => {
  assert.deepEqual(await ask("ping"), { jsonrpc: "2.0", id: 7, result: {} });
  const listed = (await ask("tools/list")) as { result: { tools: { name: string; inputSchema: object }[] } };
  assert.deepEqual(
    listed.result.tools.map((t) => t.name),
    ["echo", "breaks"],
  );
  assert.ok(!("run" in listed.result.tools[0]));
  assert.equal(await handle(server, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("a method or a tool it doesn't have is a JSON-RPC error", async () => {
  assert.deepEqual(await ask("resources/list"), { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "no method resources/list" } });
  assert.deepEqual(await ask("tools/call", { name: "nope", arguments: {} }), { jsonrpc: "2.0", id: 7, error: { code: -32602, message: 'no tool "nope"' } });
  assert.deepEqual(await handle(server, { id: 1 } as never), { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "not a JSON-RPC request" } });
});

test("a tool's own error is said; any other is logged and the agent reads that it failed", async () => {
  assert.deepEqual(await ask("tools/call", { name: "echo", arguments: { words: ["a", "b"] } }), { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: '{"said":["a","b"]}' }] } });
  const ours = (await ask("tools/call", { name: "breaks", arguments: { how: "ours" } })) as { result: object };
  assert.deepEqual(ours.result, { content: [{ type: "text", text: "in words" }], isError: true });
  const other = (await ask("tools/call", { name: "breaks", arguments: { how: "other" } })) as { result: { content: { text: string }[]; isError: boolean } };
  assert.equal(other.result.isError, true);
  assert.equal(other.result.content[0].text, "breaks failed inside the server; its log says why");
  assert.match(logged.join("\n"), /TypeError: x is undefined/);
});

test("arguments are checked against the schema before the tool runs", async () => {
  for (const [args, why] of [
    [{}, "echo: words is required"],
    [{ words: "a" }, "echo: words must be a list, not string"],
    [{ words: ["a", 1] }, "echo: words[1] must be a string, not integer"],
  ] as const) {
    const reply = (await ask("tools/call", { name: "echo", arguments: args })) as { result: { content: { text: string }[]; isError: boolean } };
    assert.deepEqual([reply.result.isError, reply.result.content[0].text], [true, why]);
  }
  const extra = (await ask("tools/call", { name: "echo", arguments: { words: [], other: 1 } })) as { result: { isError?: boolean } };
  assert.equal(extra.result.isError, undefined, "an argument it doesn't name is ignored");
});

test("over streams: one JSON line per answer (in the order they finish), a line that isn't JSON says so, and it ends with its input", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: unknown[] = [];
  output.on("data", (d: Buffer) => lines.push(...String(d).trim().split("\n").map((l) => JSON.parse(l))));
  const done = serveStdio(server, input, output, () => {});
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n{oops\n');
  input.end('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":"b","method":"ping"}\n');
  await done;
  const byId = (a: unknown, b: unknown) => String((a as { id: unknown }).id).localeCompare(String((b as { id: unknown }).id));
  assert.deepEqual(lines.sort(byId), [
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: "b", result: {} },
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } },
  ]);
});
