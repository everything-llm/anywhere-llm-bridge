import assert from "node:assert/strict";
import { test } from "node:test";
import { fromEnv } from "../src/control/settings.mts";

test("with nothing set, it serves the chat role from AnythingLLM's default port", () => {
  assert.deepEqual(fromEnv({}), { url: "http://127.0.0.1:3001", roles: ["chat"] });
});

test("AnythingLLM's own SERVER_PORT is its address, and ANYTHINGLLM_URL wins", () => {
  assert.equal(fromEnv({ SERVER_PORT: "3005" }).url, "http://127.0.0.1:3005");
  assert.equal(fromEnv({ SERVER_PORT: "3005", ANYTHINGLLM_URL: "http://host:9" }).url, "http://host:9");
});

test("the roles are read, trimmed and kept once each", () => {
  assert.deepEqual(fromEnv({ ANYTHINGLLM_MCP_ROLES: " schedule , chat,chat" }).roles, ["schedule", "chat"]);
});

test("a role that does not exist is refused, naming those that do", () => {
  for (const roles of ["", " , ", "admin", "chat,admin"]) assert.throws(() => fromEnv({ ANYTHINGLLM_MCP_ROLES: roles }), /one or more of chat, schedule/, roles);
});
