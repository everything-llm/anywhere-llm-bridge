// The bridge's HTTP side (BRIDGE_PORT, 8467): a bridge to AnythingLLM's internal API for a client
// such as AnywhereLLM Lite, with no login of its own.
//
//   GET /health            no key needed
//   GET /asks/<id>         an ask of the fence's, and POST it {decision} to answer it (asks.mts)
//   GET /allowed           the addresses always allowed, and DELETE /allowed?origin=<origin> to
//                          take one off
//   <METHOD> /<path>       AnythingLLM's own `/api/<path>`, its status and JSON passed through,
//                          for the routes BRIDGE_ALLOW lists (allow.mts); any other is 403
//
// Every route but /health needs a developer key AnythingLLM accepts (Authorization: Bearer <key>);
// the asks and the allowed addresses take only the key named AnywhereLLM, the phones' own, so no other
// key (an agent's) answers an ask. Any origin may call them, and a preflight needs no key. The
// asks and the allowed addresses are there only when the bridge knows AnythingLLM's storage. The
// bridge's own failures are `{"error": "..."}`: 400 a bad request, 401 no accepted key, 403 a route
// not allowed, 404 no such ask or address, 409 an ask answered or expired, 502 AnythingLLM can't be
// reached or refused the bridge's login, 503 a file another writer holds.

import http from "node:http";
import { METHODS, route, show, type Rule } from "./allow.mts";
import { checkDecision, type Asks } from "./asks.mts";
import { BridgeError, forbidden, invalid, notAllowed, notFound, tooLarge, unauthorized } from "./errors.mts";
import { KEY_NAME } from "./pair.mts";
import type { Upstream } from "./upstream.mts";

const SERVICE = "anywherellm-bridge";
const BRIDGE_TIMEOUT = 120_000; // a route may wait on a provider or an MCP server (AnythingLLM's 30 s)
const MAX_BODY = 8 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": [...METHODS, "OPTIONS"].join(", "),
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "600",
};

interface Deps {
  rules: Rule[];
  upstream: Upstream;
  /** The fence's asks in AnythingLLM's storage; null when the bridge doesn't know the storage. */
  asks?: Asks | null;
  /** One line per request: the method, the path (never the query or the key) and the status. */
  log: (line: string) => void;
}

function keyOf(req: http.IncomingMessage): string {
  const [scheme, ...rest] = (req.headers.authorization ?? "").split(" ");
  return scheme.toLowerCase() === "bearer" ? rest.join(" ").trim() : "";
}

async function bodyOf(req: http.IncomingMessage): Promise<unknown> {
  if (Number(req.headers["content-length"]) > MAX_BODY) throw tooLarge("the request is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw tooLarge("the request is too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw invalid("send JSON");
  }
}

function send(res: http.ServerResponse, status: number, json: unknown): void {
  const noBody = status === 204 || status === 304;
  res.writeHead(status, { ...CORS, ...(noBody ? {} : { "Content-Type": "application/json" }) });
  res.end(noBody ? undefined : JSON.stringify(json ?? null));
}

/** Whether `path` is one of the bridge's own routes rather than AnythingLLM's. */
const isOwn = (path: string): boolean => path === "/allowed" || path === "/asks" || path.startsWith("/asks/");

/** The `origin` parameter of a query, or a 400. */
function originIn(query: string): string {
  const origin = new URLSearchParams(query).get("origin");
  if (!origin) throw invalid("name the address: ?origin=<scheme://host:port>");
  return origin;
}

/** The answer to one of the bridge's own routes, `path` decoded and `query` as sent. */
async function own(asks: Asks, method: string, path: string, query: string, body: () => Promise<unknown>): Promise<unknown> {
  const [, kind, arg, ...more] = path.split("/");
  if (more.length) throw notFound("no such route");
  if (kind === "asks" && arg) {
    if (method === "GET") return { ask: asks.get(arg) };
    if (method === "POST") return { ask: await asks.decide(arg, checkDecision(((await body()) as { decision?: unknown } | undefined)?.decision)) };
    throw notAllowed("an ask is read with GET and answered with POST");
  }
  if (kind === "allowed" && arg === undefined) {
    if (method === "GET") return { origins: asks.allowed() };
    if (method === "DELETE") return { origins: await asks.forget(originIn(query)) };
    throw notAllowed("the allowed addresses are read with GET, and one taken off with DELETE");
  }
  throw notFound("no such route");
}

export function createServer({ rules, upstream, asks = null, log }: Deps): http.Server {
  const allow = rules.map(show);
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, gone: AbortSignal): Promise<void> {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const cut = url.indexOf("?");
    const rawPath = cut < 0 ? url : url.slice(0, cut);
    const query = cut < 0 ? "" : url.slice(cut + 1);
    if (method === "OPTIONS") return send(res, 204, null);
    if (method === "GET" && rawPath === "/health") return send(res, 200, { ok: true, service: SERVICE, allow, asks: asks !== null });
    let path: string;
    try {
      path = decodeURIComponent(rawPath); // as a router hands it on: an encoded `/` is a separator
    } catch {
      throw invalid("bad path");
    }
    const key = keyOf(req);
    if (asks && isOwn(path)) {
      const name = await upstream.keyName(key);
      if (name === null) throw unauthorized("send a developer API key AnythingLLM accepts");
      if (name !== KEY_NAME) throw forbidden(`only the developer key named ${KEY_NAME}, the one pair hands out, answers asks`);
      return send(res, 200, await own(asks, method, path, query, () => bodyOf(req)));
    }
    if (!(await upstream.keyValid(key))) throw unauthorized("send a developer API key AnythingLLM accepts");
    if (!METHODS.includes(method)) throw notAllowed(`the bridge passes ${METHODS.join(", ")}, not ${method}`);
    const body = await bodyOf(req);
    const reply = await upstream.exchange(method, route(rules, method, path, query), body, BRIDGE_TIMEOUT, gone);
    send(res, reply.status, reply.json);
  }

  return http.createServer((req, res) => {
    // A client that leaves before the answer ends the upstream call too.
    const left = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) left.abort();
    });
    handle(req, res, left.signal)
      .catch((e: unknown) => {
        const known = e instanceof BridgeError;
        if (!known && (e as Error).name !== "AbortError") log(`error: ${(e as Error).stack ?? e}`);
        if (left.signal.aborted) return; // nobody is there to be told
        if (res.headersSent) return res.destroy();
        send(res, known ? e.status : 500, { error: known ? e.message : "the bridge failed" });
      })
      .finally(() => log(`${req.method} ${(req.url ?? "").split("?", 1)[0]} ${left.signal.aborted ? "client closed" : res.statusCode}`));
  });
}
