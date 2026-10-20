// The MCP server side over stdio, as much of it as a server of tools needs: newline-delimited
// JSON-RPC 2.0 on stdin and stdout, answering initialize, ping, tools/list and tools/call. The SDK
// would bring about seventeen packages for these four methods.
//
// A tool's arguments are checked against its input schema first (the subset the tools use: string,
// integer, boolean, an enum, a list of strings). A ControlError, or an argument that fails the
// check, is a tool result with isError, so the agent reads why; any other error is logged on stderr
// and the agent reads that the tool failed. stdout carries only the protocol.

import readline from "node:readline";
import { ControlError } from "./anything.mts";

export interface Schema {
  type: "string" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  default?: unknown;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Schema & { type: "object"; properties: Record<string, Schema> };
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface Server {
  name: string;
  version: string;
  instructions: string;
  tools: Tool[];
}

/** The protocol versions this server speaks; a client asking for another gets the newest. */
export const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type Reply = { jsonrpc: "2.0"; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const NO_METHOD = -32601;
const INVALID_PARAMS = -32602;

const KINDS = { string: "a string", integer: "a whole number", boolean: "true or false", array: "a list", object: "an object" };

const typeOf = (value: unknown): string => (Array.isArray(value) ? "array" : value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value);

/** Why `value` doesn't fit `schema`, or null when it does. */
function misfit(value: unknown, schema: Schema, name: string): string | null {
  const found = typeOf(value);
  if (found !== schema.type) return `${name} must be ${KINDS[schema.type]}, not ${found}`;
  if (schema.enum && !schema.enum.includes(value as string)) return `${name} is one of ${schema.enum.join(", ")}, not ${JSON.stringify(value)}`;
  if (schema.type === "array" && schema.items) {
    for (const [i, item] of (value as unknown[]).entries()) {
      const wrong = misfit(item, schema.items, `${name}[${i}]`);
      if (wrong) return wrong;
    }
  }
  return null;
}

/** Why `args` don't fit a tool's input schema, or null when they do. Arguments it doesn't name are ignored. */
export function argsMisfit(args: Record<string, unknown>, schema: Tool["inputSchema"]): string | null {
  for (const name of schema.required ?? []) if (args[name] === undefined || args[name] === null) return `${name} is required`;
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties[name];
    if (!property || value === undefined || value === null) continue;
    const wrong = misfit(value, property, name);
    if (wrong) return wrong;
  }
  return null;
}

const result = (text: string, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

async function callTool(tool: Tool, params: Record<string, unknown>, log: (line: string) => void): Promise<unknown> {
  const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
  const wrong = argsMisfit(args, tool.inputSchema);
  if (wrong) return result(`${tool.name}: ${wrong}`, true);
  try {
    return result(JSON.stringify(await tool.run(args)));
  } catch (e) {
    if (e instanceof ControlError) return result(e.message, true);
    log(`${tool.name} failed: ${(e as Error).stack ?? e}`);
    return result(`${tool.name} failed inside the server; its log says why`, true);
  }
}

/** The answer to one message, or null for a notification (no id), which gets none. */
export async function handle(server: Server, message: Message, log: (line: string) => void = () => {}): Promise<Reply | null> {
  const id = message && typeof message === "object" ? (message.id ?? null) : null;
  const fail = (code: number, text: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  if (!message || typeof message !== "object" || typeof message.method !== "string") {
    return message && typeof message === "object" && message.id === undefined ? null : fail(INVALID_REQUEST, "not a JSON-RPC request");
  }
  if (message.id === undefined) return null;
  const params = message.params ?? {};
  const ok = (value: unknown): Reply => ({ jsonrpc: "2.0", id, result: value });
  switch (message.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        instructions: server.instructions,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: server.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = server.tools.find((t) => t.name === params.name);
      return tool ? ok(await callTool(tool, params, log)) : fail(INVALID_PARAMS, `no tool ${JSON.stringify(params.name)}`);
    }
    default:
      return fail(NO_METHOD, `no method ${message.method}`);
  }
}

/** Serves `server` on stdin and stdout until stdin closes. Calls are answered as they finish. */
export function serveStdio(server: Server, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, log = (line: string) => console.error(line)): Promise<void> {
  const send = (reply: Reply) => output.write(`${JSON.stringify(reply)}\n`);
  const pending = new Set<Promise<void>>();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "not JSON" } });
      return;
    }
    const done: Promise<void> = handle(server, message, log).then((reply) => {
      if (reply) send(reply);
      pending.delete(done);
    });
    pending.add(done);
  });
  return new Promise((resolve) => lines.on("close", () => Promise.all(pending).then(() => resolve())));
}
