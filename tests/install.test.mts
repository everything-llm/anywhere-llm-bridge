import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readEnv } from "../src/envfile.mts";
import { desktopStorage } from "../src/paths.mts";
import { Upstream } from "../src/upstream.mts";
import { health, install, uninstall, type Ctx, type Options } from "../src/install.mts";
import { developerKey } from "../src/pair.mts";
import { settingsFile } from "../src/settings.mts";
import { FakeAnythingLLM } from "./fakes/anythingllm.mts";
import { tempDir } from "./fakes/tmp.mts";

const DEFAULT = "/workspaces, GET /scheduled-jobs, GET /workspace/*/threads, POST /workspace/*/thread/new";
const tmp = tempDir("install");

let fake: FakeAnythingLLM;
let home: string;
let storage: string;
let printed: string[];
let ctx: Ctx;

beforeEach(async () => {
  fake = await new FakeAnythingLLM().start();
  home = fs.mkdtempSync(path.join(tmp, "home-"));
  storage = path.join(home, "storage");
  fs.mkdirSync(path.join(storage, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(storage, ".env"), "AUTH_TOKEN='pw'\n");
  printed = [];
  ctx = {
    home,
    env: { ANYTHINGLLM_URL: fake.url, BRIDGE_PORT: "1" },
    print: (l) => printed.push(l),
    command: ["/usr/bin/node", "/x/anywherellm-bridge.cjs", "serve"],
    defaultAllow: DEFAULT,
    controlSource: "",
    platform: "linux", // paths and service manager as on Linux, whatever runs the tests
    run: () => ({ status: 1, stdout: "" }), // no service manager answers
  };
});
afterEach(() => fake.stop());

const settings = () => readEnv(settingsFile(ctx));
const opts = (more: Partial<Options> = {}): Options => ({ storage, start: false, ...more });

test("install points the bridge at the storage and sets BRIDGE_ALLOW when none is; an owner's stays, empty included", async () => {
  await install(ctx, opts());
  assert.deepEqual(settings(), { ANYTHINGLLM_STORAGE: storage, BRIDGE_ALLOW: DEFAULT });
  assert.deepEqual(fake.calls, []);
  assert.match(printed.join("\n"), /give the bridge an https address/);
  fs.writeFileSync(settingsFile(ctx), "BRIDGE_ALLOW=\n");
  printed.length = 0;
  await install(ctx, opts());
  assert.equal(settings().BRIDGE_ALLOW, "");
  assert.match(printed.join("\n"), /BRIDGE_ALLOW is empty/);
});

test("with no --storage it takes the one it was given, else AnythingLLM Desktop's", async () => {
  const desktop = desktopStorage(ctx);
  fs.mkdirSync(path.join(desktop, "plugins"), { recursive: true });
  await install(ctx, opts({ storage: undefined }));
  assert.equal(settings().ANYTHINGLLM_STORAGE, desktop);
  await install(ctx, opts());
  await install(ctx, opts({ storage: undefined }));
  assert.equal(settings().ANYTHINGLLM_STORAGE, storage);
});

test("with no storage to be found it says how to name one", async () => {
  await assert.rejects(install(ctx, opts({ storage: undefined })), { status: 400, message: /--storage DIR.*mounted at \/app\/server\/storage.*bind mount.*Desktop's would be/ });
  await assert.rejects(install(ctx, opts({ storage: home })), { status: 400, message: /doesn't look like AnythingLLM's storage/ });
  fs.mkdirSync(path.join(home, "s2", "plugins"), { recursive: true });
  await install(ctx, opts({ storage: "~/s2" }));
  assert.equal(settings().ANYTHINGLLM_STORAGE, path.join(home, "s2"));
});

test("a .env that isn't there is left for the owner to name", async () => {
  fs.rmSync(path.join(storage, ".env"));
  await install(ctx, opts());
  assert.match(printed.join("\n"), /AnythingLLM's .env isn't at .*: set ANYTHINGLLM_ENV/);
});

test("uninstall with no service says so, and keeps the settings", async () => {
  await install(ctx, opts());
  uninstall(ctx);
  assert.match(printed.join("\n"), /No service of the bridge's is defined/);
  assert.deepEqual(settings(), { ANYTHINGLLM_STORAGE: storage, BRIDGE_ALLOW: DEFAULT });
});

test("health fails when the bridge isn't answering, and says which check", async () => {
  await install(ctx, opts());
  printed.length = 0;
  assert.equal(await health(ctx), false);
  const report = printed.join("\n");
  assert.match(report, /FAIL bridge on :1: no answer/);
  assert.match(report, /ok +AnythingLLM/);
  assert.match(report, /ok +the internal API's login/);
  assert.match(report, /ok +BRIDGE_ALLOW/);
});

test("health waits for an AnythingLLM that isn't answering yet, and fails only when it never does", async () => {
  await install(ctx, opts());
  const port = await new Promise<number>((done) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
  ctx.env.ANYTHINGLLM_URL = `http://127.0.0.1:${port}`;
  ctx.upWait = 1;
  printed.length = 0;
  assert.equal(await health(ctx), false);
  assert.match(printed.join("\n"), /AnythingLLM isn't answering yet: waiting up to 1 s/);
  assert.match(printed.join("\n"), /FAIL AnythingLLM: http:\/\/127\.0\.0\.1:\d+: no answer in 1 s/);

  ctx.upWait = 10;
  printed.length = 0;
  const late = http.createServer((req, res) => res.writeHead(req.url === "/api/ping" ? 200 : 404).end());
  const starting = setTimeout(() => late.listen(port, "127.0.0.1"), 700);
  try {
    await health(ctx);
    assert.match(printed.join("\n"), /AnythingLLM isn't answering yet/);
    assert.match(printed.join("\n"), /ok +AnythingLLM: http:\/\/127\.0\.0\.1:\d+: 200/);
  } finally {
    clearTimeout(starting);
    late.close();
  }
});

test("the named developer key is reused, and made when there is none", async () => {
  const api = new Upstream(fake.url, null);
  fake.replies.set("GET /system/api-keys", { json: { apiKeys: [{ name: "other", secret: "o" }, { name: "AnywhereLLM", secret: "phone" }] } });
  assert.equal(await developerKey(api), "phone");
  assert.equal(fake.calls.length, 1);
  fake.replies.set("GET /system/api-keys", { json: { apiKeys: [] } });
  fake.replies.set("POST /system/generate-api-key", { json: { apiKey: { secret: "new" } } });
  assert.equal(await developerKey(api), "new");
  fake.replies.set("POST /system/generate-api-key", { json: { error: "no" } });
  await assert.rejects(developerKey(api), /made no key: no/);
  fake.replies.set("GET /system/api-keys", { status: 500, json: { error: "boom" } });
  await assert.rejects(developerKey(api), /answered 500: boom/);
});
