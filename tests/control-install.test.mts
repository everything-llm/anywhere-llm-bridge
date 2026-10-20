import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checks, entry, installed, put, serversFile, setEntry, take } from "../src/control/install.mts";
import { health, install, uninstall, type Ctx } from "../src/install.mts";
import { tempDir } from "./fakes/tmp.mts";

const tmp = tempDir("control-install");
const SOURCE = "// the control server\n";
const ENTRY = entry("container", "/unused", ["chat"], "/usr/bin/node");

const storage = (): string => {
  const dir = fs.mkdtempSync(path.join(tmp, "storage-"));
  fs.mkdirSync(path.join(dir, "plugins"));
  return dir;
};
const servers = (dir: string) => JSON.parse(fs.readFileSync(serversFile(dir), "utf8")).mcpServers;

test("a container's entry runs its own node on the path it sees; a native one, this node on the host's", () => {
  assert.deepEqual(entry("container", "/srv/s", ["chat", "schedule"], "/usr/bin/node"), {
    command: "node",
    args: ["/app/server/storage/anywherellm-bridge/control.cjs"],
    env: { ANYTHINGLLM_MCP_ROLES: "chat,schedule" },
  });
  assert.deepEqual(entry("native", "/home/u/storage", ["chat"], "/opt/node/bin/node"), {
    command: "/opt/node/bin/node",
    args: [path.join("/home/u/storage", "anywherellm-bridge", "control.cjs")],
    env: { ANYTHINGLLM_MCP_ROLES: "chat" },
  });
});

test("put writes the server and the entry, and a second put changes nothing", () => {
  const dir = storage();
  const first = put(dir, SOURCE, ENTRY);
  assert.equal(fs.readFileSync(path.join(dir, "anywherellm-bridge", "control.cjs"), "utf8"), SOURCE);
  assert.deepEqual(servers(dir), { control: ENTRY });
  assert.match(first.join("\n"), /wrote the control server.*\n.*set control/);
  assert.ok(put(dir, SOURCE, ENTRY).every((line) => line.startsWith("unchanged")));
  assert.ok(installed(dir));
});

test("the servers file keeps other servers and AnythingLLM's settings in ours, and is written in place", () => {
  const dir = storage();
  const theirs = { command: "npx", args: ["some-server"] };
  fs.writeFileSync(serversFile(dir), JSON.stringify({ mcpServers: { theirs, control: { ...ENTRY, anythingllm: { suppressedTools: ["chat_delete"] } } }, other: 1 }));
  const inode = fs.statSync(serversFile(dir)).ino;
  const wanted = entry("container", dir, ["chat", "schedule"], "node");
  setEntry(dir, wanted);
  const found = JSON.parse(fs.readFileSync(serversFile(dir), "utf8"));
  assert.deepEqual(found, { mcpServers: { theirs, control: { ...wanted, anythingllm: { suppressedTools: ["chat_delete"] } } }, other: 1 });
  assert.equal(fs.statSync(serversFile(dir)).ino, inode);
  assert.match(setEntry(dir, null), /dropped control/);
  assert.deepEqual(servers(dir), { theirs });
  assert.match(setEntry(dir, null), /no control entry/);
});

test("another server named control is refused, the suite's old one included; a servers file that isn't JSON is refused", () => {
  const dir = storage();
  const old = { command: "node", args: ["/app/server/storage/anywherellm-suite/control.cjs"] };
  for (const theirs of [{ command: "npx", args: ["someone-elses"] }, old]) {
    fs.writeFileSync(serversFile(dir), JSON.stringify({ mcpServers: { control: theirs } }));
    assert.throws(() => setEntry(dir, ENTRY), { message: /a server named control that isn't ours/ });
  }
  fs.writeFileSync(serversFile(dir), "{oops");
  assert.throws(() => setEntry(dir, ENTRY), /isn't JSON/);
});

test("a native entry on Windows is still ours", () => {
  const dir = storage();
  const windows = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\u\\AppData\\Roaming\\anythingllm-desktop\\storage\\anywherellm-bridge\\control.cjs"] };
  fs.writeFileSync(serversFile(dir), JSON.stringify({ mcpServers: { control: windows } }));
  assert.match(setEntry(dir, ENTRY), /set control/);
});

test("take removes the server and the entry, and leaves other servers", () => {
  const dir = storage();
  put(dir, SOURCE, ENTRY);
  take(dir);
  assert.deepEqual(servers(dir), {});
  assert.ok(!fs.existsSync(path.join(dir, "anywherellm-bridge", "control.cjs")));
  assert.ok(!installed(dir));
});

test("checks find what is missing or not this version's", () => {
  const dir = storage();
  const failing = () => checks(dir, SOURCE).filter(([, ok]) => !ok).map(([what, , detail]) => `${what}: ${detail}`);
  assert.deepEqual(failing(), ["the control server: missing: run install --control again", `the control entry: missing from ${serversFile(dir)}`]);
  put(dir, SOURCE, ENTRY);
  assert.deepEqual(failing(), []);
  fs.writeFileSync(path.join(dir, "anywherellm-bridge", "control.cjs"), "old");
  assert.deepEqual(failing(), ["the control server: not this version's: run install --control again"]);
});

test("a storage that isn't the user's to write says what to do", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = storage();
  fs.chmodSync(dir, 0o555);
  try {
    assert.throws(() => put(dir, SOURCE, ENTRY), { message: /belongs to another user.*podman unshare/ });
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test("the storage path inside the container is the pinned image's", () => {
  const versions = fs.readFileSync(fileURLToPath(new URL("../versions.env", import.meta.url)), "utf8");
  const inner = /^INNER_STORAGE=(.+)$/m.exec(versions)?.[1];
  assert.deepEqual(entry("container", "/x", ["chat"], "node").args, [`${inner}/anywherellm-bridge/control.cjs`]);
});

/** The bridge's own install, asked for the control server too. */
function machine() {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  const dir = path.join(home, "storage");
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".env"), "AUTH_TOKEN='pw'\n");
  const printed: string[] = [];
  const ctx: Ctx = {
    home,
    env: { BRIDGE_PORT: "1" },
    print: (l) => printed.push(l),
    command: ["/usr/bin/node", "/x/anywherellm-bridge.cjs", "serve"],
    defaultAllow: "/workspaces",
    platform: "linux",
    run: () => ({ status: 1, stdout: "" }),
    controlSource: SOURCE,
    node: "/opt/node/bin/node",
  };
  return { ctx, dir, printed };
}

test("install --control puts the server in without starting the bridge; a reinstall keeps its runtime and roles, and --roles changes them", async () => {
  const { ctx, dir, printed } = machine();
  await install(ctx, { storage: dir, start: false, control: true, roles: ["chat", "schedule"] });
  assert.deepEqual(servers(dir).control.env, { ANYTHINGLLM_MCP_ROLES: "chat,schedule" });
  assert.equal(servers(dir).control.command, "node", "a storage that isn't Desktop's is a container's");
  assert.match(printed.join("\n"), /refresh the MCP servers/);
  await install(ctx, { storage: dir, start: false, control: true });
  assert.deepEqual(servers(dir).control.env, { ANYTHINGLLM_MCP_ROLES: "chat,schedule" });
  await install(ctx, { storage: dir, start: false, control: true, runtime: "native", roles: ["chat"] });
  assert.deepEqual(servers(dir).control, { command: "/opt/node/bin/node", args: [path.join(dir, "anywherellm-bridge", "control.cjs")], env: { ANYTHINGLLM_MCP_ROLES: "chat" } });
});

test("install without --control leaves a control server alone; a bad role or runtime is refused before anything is written", async () => {
  const { ctx, dir } = machine();
  await install(ctx, { storage: dir, start: false });
  assert.ok(!installed(dir));
  await assert.rejects(install(ctx, { storage: dir, start: false, control: true, roles: ["admin"] }), /--roles is one or more of chat, schedule, not admin/);
  await assert.rejects(install(ctx, { storage: dir, start: false, control: true, runtime: "vm" as never }), /--runtime is container or native/);
  assert.ok(!fs.existsSync(path.join(dir, "anywherellm-bridge")));
});

test("uninstall takes the control server out, and health checks it", async () => {
  const { ctx, dir, printed } = machine();
  await install(ctx, { storage: dir, start: false, control: true });
  printed.length = 0;
  await health(ctx).catch(() => false);
  assert.match(printed.join("\n"), /ok   the control server\nok   the control entry/);
  uninstall(ctx);
  assert.ok(!installed(dir));
  assert.match(printed.join("\n"), /dropped control/);
});
