import assert from "node:assert/strict";
import { test } from "node:test";
import { Anything, bounded, slug } from "../src/control/anything.mts";

const answering = (status: number, json: unknown) => new Anything(async () => ({ status, json }));

test("it sends the method, the path and the body, and gives back the JSON", async () => {
  const seen: unknown[] = [];
  const api = new Anything(async (...call) => {
    seen.push(call);
    return { status: 200, json: { ok: 1 } };
  });
  assert.deepEqual(await api.call("DELETE", "/workspace/home/thread/a/delete-edited-chats", { startingId: 3 }), { ok: 1 });
  await api.call("GET", "/scheduled-jobs");
  assert.deepEqual(seen, [
    ["DELETE", "/workspace/home/thread/a/delete-edited-chats", { startingId: 3 }],
    ["GET", "/scheduled-jobs", undefined],
  ]);
});

test("a 404 is not found, in AnythingLLM's words or ours", async () => {
  await assert.rejects(answering(404, { job: null, error: "Job not found" }).call("GET", "/scheduled-jobs/9"), /^Error: Job not found$/);
  await assert.rejects(answering(404, null).call("GET", "/workspace/x/threads"), /no such workspace, chat or job/);
});

test("any other error keeps the reason without the JSON around it", async () => {
  await assert.rejects(answering(400, { job: null, error: "Invalid cron expression" }).call("POST", "/scheduled-jobs/new", {}), /^Error: 400: Invalid cron expression$/);
  await assert.rejects(answering(401, { error: "Invalid auth token" }).call("GET", "/x"), /^Error: 401: Invalid auth token$/);
  await assert.rejects(answering(502, null).call("GET", "/x"), /^Error: 502: no reason given$/);
});

test("a bare OK reads as null", async () => {
  assert.equal(await answering(200, null).call("DELETE", "/x"), null);
});

test("an AnythingLLM that can't be reached is said so", async () => {
  const api = new Anything(async () => {
    throw new Error("AnythingLLM can't be reached: connect ECONNREFUSED");
  });
  await assert.rejects(api.call("GET", "/workspaces"), /can't be reached/);
});

test("a slug is one path segment, and anything else is refused by name", () => {
  for (const good of ["home", "a-b_C9", "0b1c-4d", "x".repeat(100)]) assert.equal(slug(good, "chat"), good);
  for (const bad of ["", ".", "..", "a/b", "a b", "a?b", "a\n", "é", "x".repeat(101)]) assert.throws(() => slug(bad, "workspace"), /workspace must be a slug/, bad);
});

test("bounded text is trimmed and 1 to a limit long", () => {
  assert.equal(bounded("  Plan  ", "a chat name", 10), "Plan");
  for (const bad of ["", "   ", "x".repeat(11)]) assert.throws(() => bounded(bad, "a chat name", 10), /a chat name is 1 to 10 characters/);
});
