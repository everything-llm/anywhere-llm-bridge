// The bridge against the real thing, which tools/e2e starts and names in the environment:
//
//   E2E_ALLM_URL, E2E_PASSWORD  AnythingLLM from here, and its password (AUTH_TOKEN)
//   E2E_BRIDGE_URL, E2E_KEY     the bridge `install` set up and `serve` runs, and a developer key
//   E2E_WORKSPACE               the slug of the one workspace AnythingLLM holds
//   E2E_CLI                     the built anywherellm-bridge.cjs, with its settings in the environment
//
// Also E2E_ENGINE, E2E_CONTAINER, E2E_ALLM_PORT, E2E_BRIDGE_PORT and E2E_STORAGE, for a client's own e2e.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

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
});
