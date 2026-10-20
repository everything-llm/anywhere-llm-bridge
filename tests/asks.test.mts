import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseRules } from "../src/allow.mts";
import { Asks, checkOrigin } from "../src/asks.mts";
import { createServer } from "../src/server.mts";
import { Upstream } from "../src/upstream.mts";
import { FakeAnythingLLM } from "./fakes/anythingllm.mts";
import { close, listen } from "./fakes/net.mts";
import { tempDir } from "./fakes/tmp.mts";

const tmp = tempDir("asks");
const ID = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-10-20T12:00:00Z");

let fake: FakeAnythingLLM;
let bridge: ReturnType<typeof createServer>;
let url: string;
let dir: string;

/** An ask as a skill writes it, expiring `inMs` after NOW. */
function writeAsk(fields: Record<string, unknown> = {}, inMs = 60_000): string {
  const ask = {
    id: ID,
    host: "muse-vm",
    origin: "http://muse-vm:8463",
    skill: "Library",
    workspace: "home",
    why: "Send a request to http://muse-vm:8463",
    asked: NOW.toISOString(),
    expires: new Date(NOW.getTime() + inMs).toISOString(),
    decision: null,
    decided: null,
    ...fields,
  };
  fs.mkdirSync(path.join(dir, "asks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "asks", `${ask.id}.json`), JSON.stringify(ask));
  return ask.id as string;
}

const allowedFile = () => path.join(dir, "allowed.json");
const readAsk = (id = ID) => JSON.parse(fs.readFileSync(path.join(dir, "asks", `${id}.json`), "utf8"));

async function start(withAsks = true): Promise<void> {
  bridge = createServer({
    rules: parseRules("/workspaces"),
    upstream: new Upstream(fake.url, null),
    asks: withAsks ? new Asks(dir, () => NOW) : null,
    log: () => {},
  });
  url = `http://127.0.0.1:${await listen(bridge)}`;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(tmp, "fence-lean-"));
  fake = await new FakeAnythingLLM().start();
  fake.keys.add("agent-key");
  fake.replies.set("GET /system/api-keys", {
    json: { apiKeys: [{ id: 1, name: "AnywhereLLM", secret: "good-key" }, { id: 2, name: "agent", secret: "agent-key" }] },
  });
  await start();
});
afterEach(async () => {
  await close(bridge);
  await fake.stop();
});

const call = async (method: string, route: string, body?: unknown, key = "good-key") => {
  const res = await fetch(url + route, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

test("/health says the bridge serves asks only when it knows the storage", async () => {
  assert.equal(((await (await fetch(url + "/health")).json()) as { asks: boolean }).asks, true);
  await close(bridge);
  await start(false);
  assert.equal(((await (await fetch(url + "/health")).json()) as { asks: boolean }).asks, false);
  // Without the storage the paths are AnythingLLM's, which BRIDGE_ALLOW doesn't pass.
  assert.equal((await call("GET", `/asks/${ID}`)).status, 403);
});

test("an ask is read as the skill wrote it", async () => {
  writeAsk();
  const res = await call("GET", `/asks/${ID}`);
  assert.equal(res.status, 200);
  assert.deepEqual([res.json.ask.host, res.json.ask.origin, res.json.ask.workspace, res.json.ask.decision], ["muse-vm", "http://muse-vm:8463", "home", null]);
});

test("Allow once writes the decision and leaves the allowed addresses alone", async () => {
  writeAsk();
  const res = await call("POST", `/asks/${ID}`, { decision: "once" });
  assert.deepEqual([res.status, res.json.ask.decision, res.json.ask.decided], [200, "once", NOW.toISOString()]);
  assert.deepEqual([readAsk().decision, readAsk().decided], ["once", NOW.toISOString()]);
  assert.equal(fs.existsSync(allowedFile()), false);
  assert.equal(fs.existsSync(path.join(dir, "asks", `${ID}.json.lock`)), false);
});

test("Always allow adds the origin once, and the list is read and taken from", async () => {
  writeAsk();
  assert.equal((await call("POST", `/asks/${ID}`, { decision: "always" })).status, 200);
  const other = "f".repeat(32);
  writeAsk({ id: other });
  assert.equal((await call("POST", `/asks/${other}`, { decision: "always" })).status, 200);
  const third = "e".repeat(32);
  writeAsk({ id: third, origin: "http://muse-vm:8080" });
  assert.equal((await call("POST", `/asks/${third}`, { decision: "always" })).status, 200);
  const added = NOW.toISOString();
  assert.deepEqual((await call("GET", "/allowed")).json, {
    origins: [
      { origin: "http://muse-vm:8463", added },
      { origin: "http://muse-vm:8080", added },
    ],
  });
  assert.equal(fs.statSync(allowedFile()).mode & 0o777, 0o600);
  const gone = await call("DELETE", `/allowed?origin=${encodeURIComponent("http://muse-vm:8463")}`);
  assert.deepEqual([gone.status, gone.json], [200, { origins: [{ origin: "http://muse-vm:8080", added }] }]);
  const again = await call("DELETE", `/allowed?origin=${encodeURIComponent("http://muse-vm:8463")}`);
  assert.equal(again.status, 404);
  assert.match(again.json.error, /isn't always allowed/);
});

test("Always allow refuses an ask whose origin isn't one, and writes no decision", async () => {
  writeAsk({ origin: "HTTP://MUSE-VM:8463/x" });
  assert.equal((await call("POST", `/asks/${ID}`, { decision: "always" })).status, 400);
  assert.equal(readAsk().decision, null);
  assert.equal(fs.existsSync(allowedFile()), false);
});

test("an ask answered already or expired is a 409, and one that's gone a 404", async () => {
  writeAsk({ decision: "deny", decided: NOW.toISOString() });
  const answered = await call("POST", `/asks/${ID}`, { decision: "once" });
  assert.deepEqual([answered.status, readAsk().decision], [409, "deny"]);
  writeAsk({}, 0);
  const expired = await call("POST", `/asks/${ID}`, { decision: "always" });
  assert.equal(expired.status, 409);
  assert.match(expired.json.error, /expired/);
  assert.equal(readAsk().decision, null);
  assert.equal(fs.existsSync(allowedFile()), false);
  fs.rmSync(path.join(dir, "asks", `${ID}.json`));
  assert.equal((await call("GET", `/asks/${ID}`)).status, 404);
  assert.equal((await call("POST", `/asks/${ID}`, { decision: "deny" })).status, 404);
});

test("a bad id, address, decision or method is refused before any file is touched", async () => {
  writeAsk();
  for (const route of ["/asks/ABCDEF0123456789abcdef0123456789", "/asks/123"]) {
    const res = await call("GET", route);
    assert.equal(res.status, 400, route);
  }
  assert.equal((await call("POST", `/asks/${ID}`, { decision: "maybe" })).status, 400);
  assert.equal((await call("POST", `/asks/${ID}`)).status, 400);
  // An encoded `/` is a separator, as on the routes passed on: this has a segment too many.
  assert.equal((await call("GET", "/asks/..%2Fallowed")).status, 404);
  assert.equal((await call("DELETE", "/allowed")).status, 400);
  assert.equal((await call("DELETE", `/allowed?origin=${encodeURIComponent("http://muse-vm:8463/x")}`)).status, 400);
  assert.equal((await call("DELETE", `/asks/${ID}`)).status, 405);
  assert.equal((await call("POST", "/allowed")).status, 405);
  assert.equal((await call("GET", `/asks/${ID}/more`)).status, 404);
  assert.equal(readAsk().decision, null);
});

test("only the key named AnywhereLLM answers asks; another good key is a 403 and a bad one a 401", async () => {
  writeAsk();
  const agent = await call("POST", `/asks/${ID}`, { decision: "always" }, "agent-key");
  assert.equal(agent.status, 403);
  assert.match(agent.json.error, /named AnywhereLLM/);
  assert.equal((await call("GET", "/allowed", undefined, "agent-key")).status, 403);
  assert.equal((await call("GET", `/asks/${ID}`, undefined, "nope")).status, 401);
  assert.equal(readAsk().decision, null);
  // The agent's key still passes the routes BRIDGE_ALLOW lists.
  assert.equal((await call("GET", "/workspaces", undefined, "agent-key")).status, 200);
  assert.ok(!agent.json.error.includes("agent-key"));
});

test("the key list is asked once per key while its answer holds", async () => {
  writeAsk();
  await call("GET", `/asks/${ID}`);
  await call("GET", `/asks/${ID}`);
  assert.equal(fake.calls.filter((c) => c.url === "/system/api-keys").length, 1);
});

test("a decision waits for the skill's lock on the ask", async () => {
  writeAsk();
  const lock = path.join(dir, "asks", `${ID}.json.lock`);
  fs.mkdirSync(lock);
  const deciding = call("POST", `/asks/${ID}`, { decision: "once" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readAsk().decision, null);
  fs.rmSync(lock, { recursive: true });
  assert.equal((await deciding).status, 200);
  assert.equal(readAsk().decision, "once");
});

test("Always allow stores the origin as checked, and one written another way is still known and forgotten", async () => {
  writeAsk({ origin: " http://muse-vm:8463 " });
  assert.equal((await call("POST", `/asks/${ID}`, { decision: "always" })).status, 200);
  assert.deepEqual((await call("GET", "/allowed")).json.origins.map((o: { origin: string }) => o.origin), ["http://muse-vm:8463"]);
  // An entry the bridge didn't write: the fence reads it as its origin, so it is one to forget.
  const added = NOW.toISOString();
  fs.writeFileSync(allowedFile(), JSON.stringify({ origins: [{ origin: " HTTP://Muse-VM:80/ ", added }, { origin: "http://muse-vm:8463", added }] }));
  const other = "f".repeat(32);
  writeAsk({ id: other, origin: "http://muse-vm" });
  assert.equal((await call("POST", `/asks/${other}`, { decision: "always" })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(allowedFile(), "utf8")).origins.length, 2, "not added twice");
  const gone = await call("DELETE", `/allowed?origin=${encodeURIComponent("http://muse-vm")}`);
  assert.deepEqual([gone.status, gone.json.origins.map((o: { origin: string }) => o.origin)], [200, ["http://muse-vm:8463"]]);
});

test("an ask that is a link is refused, not followed", { skip: process.platform === "win32" }, async () => {
  const secret = path.join(tmp, `secret-${process.pid}.json`);
  fs.writeFileSync(secret, JSON.stringify({ id: ID, origin: "the host's own" }));
  fs.mkdirSync(path.join(dir, "asks"), { recursive: true });
  fs.symlinkSync(secret, path.join(dir, "asks", `${ID}.json`));
  for (const [method, body] of [["GET", undefined], ["POST", { decision: "once" }]] as const) {
    const res = await call(method, `/asks/${ID}`, body);
    assert.equal(res.status, 403, method);
    assert.match(res.json.error, /is a link/);
    assert.ok(!JSON.stringify(res.json).includes("the host's own"));
  }
  assert.equal(JSON.parse(fs.readFileSync(secret, "utf8")).origin, "the host's own");
});

test("an origin is a scheme, a host and a port, and nothing else", () => {
  assert.equal(checkOrigin(" https://muse-vm.tail1234.ts.net "), "https://muse-vm.tail1234.ts.net");
  assert.equal(checkOrigin("http://100.64.0.7:8463"), "http://100.64.0.7:8463");
  assert.equal(checkOrigin("http://[fd7a:115c:a1e0::1]"), "http://[fd7a:115c:a1e0::1]");
  // Only as URL.origin writes it: the fence writes what the skills ask for that way.
  for (const bad of ["", "muse-vm", "muse-vm:8463", "ftp://muse-vm", "HTTPS://Muse-VM", "https://muse-vm:443", "http://muse-vm/", "http://muse-vm/x", "http://muse-vm?a", "http://muse-vm#a", "http://u:p@muse-vm"]) {
    assert.throws(() => checkOrigin(bad), JSON.stringify(bad));
  }
});
