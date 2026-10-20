import assert from "node:assert/strict";
import { test } from "node:test";
import { Jobs, type JobSpec } from "../src/control/jobs.mts";
import { FakeAnythingLLM } from "./fakes/control.mts";

const jobs = (fake: FakeAnythingLLM) => new Jobs(fake.client());
const NEW: JobSpec = { name: "Weekly digest", prompt: "Summarise my week.", schedule: "0 7 * * 1", tools: ["web-scraping"] };
type Shown = Record<string, unknown>;

test("the listing reads tools from their JSON text and says UTC", async () => {
  const listing = await jobs(new FakeAnythingLLM()).listing();
  assert.equal(listing.timezone, "UTC");
  const [job] = listing.jobs as Shown[];
  assert.deepEqual([job.id, job.name, job.schedule, job.tools, job.enabled], [1, "Morning news", "30 4 * * *", ["web-browsing"], true]);
});

test("an add is shown first and changes nothing", async () => {
  const fake = new FakeAnythingLLM();
  const shown = await jobs(fake).add(NEW, false);
  assert.equal(shown.applied, false);
  assert.equal((shown.would_add as Shown).schedule, "0 7 * * 1");
  assert.equal(fake.jobs.size, 1);
  assert.deepEqual(fake.changes(), []);
});

test("an add makes the job and gives it back", async () => {
  const fake = new FakeAnythingLLM();
  const done = await jobs(fake).add(NEW, true);
  assert.equal(done.applied, true);
  assert.equal((done.job as Shown).id, 2);
  assert.deepEqual(fake.calls.at(-1)?.[2], { name: "Weekly digest", prompt: "Summarise my week.", tools: ["web-scraping"], schedule: "0 7 * * 1" });
  assert.deepEqual(JSON.parse(String(fake.jobs.get(2)?.tools)), ["web-scraping"]);
});

test("a retried add does not make a second job", async () => {
  const fake = new FakeAnythingLLM();
  await jobs(fake).add(NEW, true);
  await assert.rejects(jobs(fake).add(NEW, true), /identical job already exists \(id 2\)/);
  assert.equal(fake.jobs.size, 2);
});

test("the preview names a job with the same name", async () => {
  const shown = await jobs(new FakeAnythingLLM()).add({ name: "morning NEWS", prompt: "Other.", schedule: "0 8 * * *" }, false);
  assert.deepEqual(shown.same_name, [1]);
});

test("a job can name an imported skill, as AnythingLLM does: @@<hubId>", async () => {
  const fake = new FakeAnythingLLM();
  await jobs(fake).add({ ...NEW, tools: ["@@library-lean", "web-scraping"] }, true);
  assert.deepEqual(JSON.parse(String(fake.jobs.get(2)?.tools)), ["@@library-lean", "web-scraping"]);
});

test("a job's tools are ones AnythingLLM's catalog has, set up; a skill's bare id is told its @@", async () => {
  for (const [tools, why] of [
    [["library-lean"], /a job can't use library-lean \(an imported skill is @@library-lean\); it can use web-scraping, web-browsing, @@library-lean$/],
    [["sql-agent"], /can't use sql-agent;/],
    [["gmail-send"], /can't use gmail-send;/],
  ] as const) {
    const fake = new FakeAnythingLLM();
    await assert.rejects(jobs(fake).add({ ...NEW, tools: [...tools] }, false), why);
    await assert.rejects(jobs(fake).update(1, { tools: [...tools] }, false), why);
    assert.deepEqual(fake.changes(), [], "nothing changed");
  }
});

test("a bad job is refused before AnythingLLM", async () => {
  const bad: JobSpec[] = [
    { name: "", prompt: "p", schedule: "0 7 * * *" },
    { name: "n", prompt: " ", schedule: "0 7 * * *" },
    { name: "n", prompt: "p", schedule: "every day" },
    { name: "n", prompt: "p", schedule: "0 7 * *" },
    { name: "n", prompt: "p", schedule: "0 7 * * * *" },
    { name: "n", prompt: "p", schedule: "0 7 * * *", tools: ["not a tool id"] },
    { name: "n", prompt: "p", schedule: "0 7 * * *", tools: ["@@"] },
    { name: "n", prompt: "p", schedule: "0 7 * * *", tools: ["@library-lean"] },
    { name: "x".repeat(101), prompt: "p", schedule: "0 7 * * *" },
  ];
  for (const spec of bad) {
    const fake = new FakeAnythingLLM();
    await assert.rejects(jobs(fake).add(spec, true), /cron expression in UTC|tools are up to|1 to \d+ char/, JSON.stringify(spec));
    assert.deepEqual(fake.calls, []);
  }
});

test("AnythingLLM's own refusal is said", async () => {
  const fake = new FakeAnythingLLM();
  await assert.rejects(jobs(fake).add({ name: "n", prompt: "p", schedule: "99 7 * * *" }, true), /400: Invalid cron expression$/);
  assert.equal(fake.jobs.size, 1);
});

test("an update shows each change from and to", async () => {
  const fake = new FakeAnythingLLM();
  const shown = await jobs(fake).update(1, { schedule: "0 6 * * *", enabled: false }, false);
  assert.deepEqual(shown.changes, { schedule: { from: "30 4 * * *", to: "0 6 * * *" }, enabled: { from: true, to: false } });
  assert.equal(fake.jobs.get(1)?.schedule, "30 4 * * *");
  assert.deepEqual(fake.changes(), []);
});

test("an update changes only the fields given", async () => {
  const fake = new FakeAnythingLLM();
  const done = await jobs(fake).update(1, { enabled: false }, true);
  assert.equal((done.job as Shown).enabled, false);
  assert.deepEqual(fake.calls.at(-1), ["PUT", "/scheduled-jobs/1", { enabled: false }]);
  assert.equal(fake.jobs.get(1)?.name, "Morning news");
});

test("an update can clear the tools", async () => {
  const fake = new FakeAnythingLLM();
  await jobs(fake).update(1, { tools: [] }, true);
  assert.deepEqual(fake.calls.at(-1)?.[2], { tools: [] });
});

test("an update that changes nothing says so and sends nothing", async () => {
  const fake = new FakeAnythingLLM();
  assert.equal((await jobs(fake).update(1, { name: "Morning news" }, true)).applied, false);
  assert.deepEqual(fake.changes(), []);
});

test("an update needs something to change and a job that exists", async () => {
  const fake = new FakeAnythingLLM();
  await assert.rejects(jobs(fake).update(1, {}, true), /say what to change/);
  await assert.rejects(jobs(fake).update(9, { enabled: false }, true), /Job not found/);
  await assert.rejects(jobs(fake).update(0, { enabled: false }, true), /whole number from 1/);
  assert.deepEqual(fake.changes(), []);
});

test("a bad new schedule in an update is refused before AnythingLLM", async () => {
  const fake = new FakeAnythingLLM();
  await assert.rejects(jobs(fake).update(1, { schedule: "daily" }, true), /cron/);
  assert.deepEqual(fake.calls, []);
});

test("a delete is shown first, then removes the job", async () => {
  const fake = new FakeAnythingLLM();
  const shown = await jobs(fake).delete(1, false);
  assert.equal((shown.would_delete as Shown).name, "Morning news");
  assert.ok(fake.jobs.has(1));
  const done = await jobs(fake).delete(1, true);
  assert.deepEqual([done.deleted, done.name], [1, "Morning news"]);
  assert.equal(fake.jobs.size, 0);
});

test("deleting a job that is gone is not found", async () => {
  await assert.rejects(jobs(new FakeAnythingLLM()).delete(7, true), /Job not found/);
});
