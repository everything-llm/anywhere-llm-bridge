import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseRules } from "../src/allow.mts";
import { createServer } from "../src/server.mts";
import { Upstream } from "../src/upstream.mts";
import { FakeAnythingLLM } from "./fakes/anythingllm.mts";
import { close, listen } from "./fakes/net.mts";
import { tempDir } from "./fakes/tmp.mts";

const tmp = tempDir("pages");
const LIBRARY = "/library-lean/AbCdEfGhIjKlMnOpQrStUv_-.html";
const VAULT = "/vault-lean/0123456789abcdefABCDEF-_.html";

let fake: FakeAnythingLLM;
let bridge: ReturnType<typeof createServer>;
let url: string;
let storage: string;
let logged: string[];

const linksFile = () => path.join(storage, "anywherellm-suite", "page-links.json");

/** The links file as the suite's skills write it. */
function writeLinks(links: unknown): void {
  fs.mkdirSync(path.dirname(linksFile()), { recursive: true });
  fs.writeFileSync(linksFile(), typeof links === "string" ? links : JSON.stringify(links));
}

async function start(withStorage = true): Promise<void> {
  logged = [];
  bridge = createServer({
    rules: parseRules("/workspaces"),
    upstream: new Upstream(fake.url, null),
    storage: withStorage ? storage : null,
    log: (line) => logged.push(line),
  });
  url = `http://127.0.0.1:${await listen(bridge)}`;
}

beforeEach(async () => {
  storage = fs.mkdtempSync(path.join(tmp, "storage-"));
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

const call = async (method: string, route: string, key = "good-key") => {
  const res = await fetch(url + route, { method, headers: { Authorization: `Bearer ${key}` } });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

test("/health says the bridge serves /pages only when it knows the storage", async () => {
  assert.equal(((await (await fetch(url + "/health")).json()) as { pages: boolean }).pages, true);
  await close(bridge);
  await start(false);
  assert.equal(((await (await fetch(url + "/health")).json()) as { pages: boolean }).pages, false);
  // Without the storage the path is AnythingLLM's, which BRIDGE_ALLOW doesn't pass.
  writeLinks({ library: LIBRARY, vault: VAULT });
  assert.equal((await call("GET", "/pages")).status, 403);
});

test("the two pages' paths are read as the suite wrote them, afresh at each call", async () => {
  writeLinks({ library: LIBRARY, vault: VAULT, rotated: { vault: "2026-10-21T12:00:00.000Z" } });
  assert.deepEqual(await call("GET", "/pages"), { status: 200, json: { library: LIBRARY, vault: VAULT } });
  const rotated = "/vault-lean/zzzzzzzzzzzzzzzzzzzzzzzz.html";
  writeLinks({ library: LIBRARY, vault: rotated });
  assert.deepEqual((await call("GET", "/pages")).json, { library: LIBRARY, vault: rotated });
  // The log has the route, never a page's path.
  assert.ok(logged.includes("GET /pages 200"), logged.join("\n"));
  assert.ok(!logged.join("\n").includes("-lean/"));
});

test("a page not shown yet, or no file at all, is null", async () => {
  assert.deepEqual(await call("GET", "/pages"), { status: 200, json: { library: null, vault: null } });
  writeLinks({ vault: VAULT });
  assert.deepEqual((await call("GET", "/pages")).json, { library: null, vault: VAULT });
});

test("a path that isn't exactly the suite's shape is null, and never shown", async () => {
  const planted = [
    "/library-lean/../x.html",
    "/library-lean/AbCdEfGhIjKlMnOpQrStUv_.html", // 23 characters
    "/library-lean/AbCdEfGhIjKlMnOpQrStUv_-x.html", // 25
    "/library-lean/AbCdEfGhIjKlMnOpQrStU%2F.html",
    "/library-lean/AbCdEfGhIjKlMnOpQrStUv_-.html?x",
    "/library-lean/AbCdEfGhIjKlMnOpQrStUv_-.html\n",
    "https://evil.example/library-lean/AbCdEfGhIjKlMnOpQrStUv_-.html",
    "//evil.example/library-lean/AbCdEfGhIjKlMnOpQrStUv_-.html",
    "/vault-lean/AbCdEfGhIjKlMnOpQrStUv_-.html", // the other page's folder
    "/library/AbCdEfGhIjKlMnOpQrStUv_-.html",
  ];
  for (const bad of planted) {
    writeLinks({ library: bad, vault: VAULT });
    const res = await call("GET", "/pages");
    assert.deepEqual(res, { status: 200, json: { library: null, vault: VAULT } }, JSON.stringify(bad));
  }
  for (const bad of [LIBRARY, 42, null, [VAULT], { path: VAULT }]) {
    writeLinks({ library: LIBRARY, vault: bad });
    assert.deepEqual((await call("GET", "/pages")).json, { library: LIBRARY, vault: null }, JSON.stringify(bad));
  }
  assert.ok(!logged.join("\n").includes("evil"));
});

test("a links file that isn't JSON, or not an object, gives no links and no error", async () => {
  for (const text of ["{", "", "null", "[]", `"${LIBRARY}"`, "42"]) {
    writeLinks(text);
    assert.deepEqual(await call("GET", "/pages"), { status: 200, json: { library: null, vault: null } }, text);
  }
  assert.deepEqual(logged.filter((l) => !l.startsWith("GET /pages ")), []);
});

test("only the key named AnywhereLLM reads the links; another good key is a 403 and a bad one a 401", async () => {
  writeLinks({ library: LIBRARY, vault: VAULT });
  const agent = await call("GET", "/pages", "agent-key");
  assert.equal(agent.status, 403);
  assert.match(agent.json.error, /named AnywhereLLM/);
  assert.ok(!JSON.stringify(agent.json).includes("-lean/"));
  assert.equal((await call("GET", "/pages", "nope")).status, 401);
  assert.equal((await call("POST", "/pages", "agent-key")).status, 403);
  // The agent's key still passes the routes BRIDGE_ALLOW lists.
  assert.equal((await call("GET", "/workspaces", "agent-key")).status, 200);
  assert.ok(!agent.json.error.includes("agent-key"));
});

test("/pages is read with GET alone", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await call(method, "/pages")).status, 405, method);
});

test("the key list is asked once per key while its answer holds", async () => {
  await call("GET", "/pages");
  await call("GET", "/pages");
  assert.equal(fake.calls.filter((c) => c.url === "/system/api-keys").length, 1);
});

test("a links file that is a link is not followed", { skip: process.platform === "win32" }, async () => {
  const secret = path.join(tmp, `secret-${process.pid}.json`);
  fs.writeFileSync(secret, JSON.stringify({ library: LIBRARY, vault: VAULT }));
  fs.mkdirSync(path.dirname(linksFile()), { recursive: true });
  fs.symlinkSync(secret, linksFile());
  assert.deepEqual(await call("GET", "/pages"), { status: 200, json: { library: null, vault: null } });
});
