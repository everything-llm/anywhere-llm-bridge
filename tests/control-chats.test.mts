import assert from "node:assert/strict";
import { test } from "node:test";
import { Chats, exchangesOf, SHOWN } from "../src/control/chats.mts";
import { FakeAnythingLLM } from "./fakes/control.mts";

const chats = (fake: FakeAnythingLLM) => new Chats(fake.client());

test("the workspaces and their chats are listed by slug", async () => {
  const found = chats(new FakeAnythingLLM());
  assert.deepEqual((await found.workspaces()).workspaces, [
    { workspace: "home", name: "Home" },
    { workspace: "work", name: "Work" },
  ]);
  const listing = (await found.listing("home")).chats as { chat: string; name: string }[];
  assert.deepEqual(
    listing.map((c) => [c.chat, c.name]),
    [
      ["aaa-1", "Trip planning"],
      ["bbb-2", "Thread"],
    ],
  );
});

test("a history pairs a question with its answer by chat id", () => {
  const history = [{ role: "user", content: "q1", chatId: 5 }, { role: "assistant", content: "a1", chatId: 5 }, { role: "user", content: "q2", chatId: 6 }, { role: "user", content: "no id" }, "junk"];
  assert.deepEqual(exchangesOf(history), [
    { chatId: 5, question: "q1", answer: "a1" },
    { chatId: 6, question: "q2", answer: "" },
  ]);
  assert.deepEqual(exchangesOf({ not: "a list" }), []);
});

test("a history shows the last exchanges, cut short", async () => {
  const fake = new FakeAnythingLLM();
  fake.chats["aaa-1"].push([12, "Long?", "x".repeat(2000)]);
  const found = await chats(fake).history("home", "aaa-1", 2);
  const shown = found.shown as { chatId: number; answer: string }[];
  assert.equal(found.exchanges, 3);
  assert.deepEqual(
    shown.map((e) => e.chatId),
    [11, 12],
  );
  assert.ok(shown[1].answer.length < SHOWN + 20);
  await assert.rejects(chats(fake).history("home", "aaa-1", 0), /last is from 1 to 50/);
});

test("a new chat is named Thread until renamed", async () => {
  const fake = new FakeAnythingLLM();
  const made = await chats(fake).new("work");
  assert.equal(made.name, "Thread");
  assert.deepEqual(await chats(fake).rename("work", made.chat as string, "  Quarterly plan "), { chat: made.chat, name: "Quarterly plan" });
  assert.deepEqual(fake.threads.work, { [made.chat as string]: "Quarterly plan" });
});

test("a rename needs a name and a chat that exists", async () => {
  const fake = new FakeAnythingLLM();
  for (const bad of ["", "   ", "x".repeat(101)]) await assert.rejects(chats(fake).rename("home", "aaa-1", bad), /a chat's name is 1 to 100 characters/);
  await assert.rejects(chats(fake).rename("home", "nope", "Name"), /has no chat "nope"/);
  await assert.rejects(chats(fake).rename("nowhere", "aaa-1", "Name"), /no such workspace/);
  assert.deepEqual(fake.changes(), []);
});

test("a clear is shown first and changes nothing", async () => {
  const fake = new FakeAnythingLLM();
  const shown = await chats(fake).clear("home", "aaa-1", false);
  assert.equal(shown.applied, false);
  assert.deepEqual([shown.name, shown.exchanges], ["Trip planning", 2]);
  assert.equal(fake.chats["aaa-1"].length, 2);
  assert.deepEqual(fake.changes(), []);
});

test("a clear removes every exchange and keeps the chat", async () => {
  const fake = new FakeAnythingLLM();
  const done = await chats(fake).clear("home", "aaa-1", true);
  assert.deepEqual([done.applied, done.removed], [true, 2]);
  assert.deepEqual(fake.chats["aaa-1"], []);
  assert.equal(fake.threads.home["aaa-1"], "Trip planning");
  assert.deepEqual(
    fake.calls.filter(([m]) => m !== "GET"),
    [["DELETE", "/workspace/home/thread/aaa-1/delete-edited-chats", { startingId: 10 }]],
  );
});

test("clearing an empty chat asks for nothing", async () => {
  const fake = new FakeAnythingLLM();
  assert.equal((await chats(fake).clear("home", "bbb-2", true)).applied, false);
  assert.deepEqual(fake.changes(), []);
});

test("a clear reads back and does not claim a clear that did nothing", async () => {
  const fake = new FakeAnythingLLM();
  fake.ignoresDeletes = true;
  await assert.rejects(chats(fake).clear("home", "aaa-1", true), /2 of 2 exchanges are still there/);
});

test("a delete is shown first, then removes the chat and reads it back", async () => {
  const fake = new FakeAnythingLLM();
  const shown = await chats(fake).delete("home", "aaa-1", false);
  assert.deepEqual([shown.applied, shown.exchanges], [false, 2]);
  assert.ok("aaa-1" in fake.threads.home);
  assert.equal((await chats(fake).delete("home", "aaa-1", true)).deleted, true);
  assert.ok(!("aaa-1" in fake.threads.home));
  assert.deepEqual(fake.changes(), [["DELETE", "/workspace/home/thread/aaa-1"]]);
});

test("a delete that changed nothing is an error", async () => {
  const fake = new FakeAnythingLLM();
  fake.ignoresDeletes = true;
  await assert.rejects(chats(fake).delete("home", "aaa-1", true), /still there/);
});

test("a slug that is not one never reaches AnythingLLM", async () => {
  for (const bad of ["../x", "a/b", "", "a b"]) {
    const fake = new FakeAnythingLLM();
    const c = chats(fake);
    for (const call of [() => c.listing(bad), () => c.history(bad, "aaa-1", 5), () => c.history("home", bad, 5), () => c.delete("home", bad, true), () => c.new(bad)]) {
      await assert.rejects(call(), /must be a slug/, bad);
    }
    assert.deepEqual(fake.calls, [], bad);
  }
});
