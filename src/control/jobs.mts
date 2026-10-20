// What the schedule tool does. A scheduled job is AnythingLLM's own: a name, a prompt the agent
// runs, optional tools, and a cron schedule in UTC. A change is shown first and made only with
// `apply`. AnythingLLM takes no idempotency key and allows two jobs alike, so an add that finds an
// identical job refuses, which makes a retried add safe.

import { bounded, ControlError, items, obj, text, type Anything, type Obj } from "./anything.mts";

export const JOB_NAME_MAX = 100;
export const MAX_PROMPT = 4000;
const MAX_TOOLS = 50;
const CRON_FIELD = /^[0-9A-Za-z*/,?#-]+$/;
/** A tool id: a built-in skill (web-scraping), a sub-skill (name#sub), or an imported skill, flow or
 *  MCP server (@@<hubId>, @@flow_<id>, @@mcp_<name>). */
const TOOL_ID = /^(@@)?[A-Za-z0-9_.#-]{1,120}$/;
const UTC = "the schedule is a cron expression in UTC: minute hour day-of-month month day-of-week";

/** A job to add. */
export interface JobSpec {
  name: string;
  prompt: string;
  schedule: string;
  tools?: string[];
}

/** The fields of a job to change; one left out stays as it is. */
export interface JobEdit {
  name?: string;
  prompt?: string;
  schedule?: string;
  tools?: string[];
  enabled?: boolean;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `value` when it can be a scheduled job's id. */
function jobId(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new ControlError(`a job is a whole number from 1; got ${JSON.stringify(value)}`);
  return value;
}

const checkedName = (name: string): string => bounded(name, "a job's name", JOB_NAME_MAX);
const checkedPrompt = (prompt: string): string => bounded(prompt, "a job's prompt", MAX_PROMPT);

/** Five cron fields. Whether they mean anything is AnythingLLM's to say, in its words. */
function checkedSchedule(schedule: string): string {
  const fields = schedule.split(/\s+/).filter(Boolean);
  if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) throw new ControlError(`${UTC}; got ${JSON.stringify(schedule.slice(0, 60))}`);
  return fields.join(" ");
}

function checkedTools(tools: string[] | undefined): string[] | undefined {
  if (tools && (tools.length > MAX_TOOLS || !tools.every((t) => TOOL_ID.test(t)))) throw new ControlError(`tools are up to ${MAX_TOOLS} ids such as web-scraping`);
  return tools;
}

/** A job's tools: AnythingLLM keeps them as JSON text, or null. */
function toolsOf(value: unknown): unknown[] {
  try {
    return items(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return [];
  }
}

/** A job as the agent reads it. The times are AnythingLLM's own, UTC. */
function shown(job: Obj): Obj {
  return {
    id: job.id ?? null,
    name: text(job.name),
    prompt: text(job.prompt),
    schedule: text(job.schedule),
    enabled: Boolean(job.enabled),
    tools: toolsOf(job.tools),
    lastRunAt: job.lastRunAt ?? null,
    nextRunAt: job.nextRunAt ?? null,
    lastStatus: obj(job.latestRun).status ?? null,
  };
}

/** The job in AnythingLLM's reply, or its reason for sending none. */
function made(reply: Obj): Obj {
  const job = obj(reply.job);
  if (!Object.keys(job).length) throw new ControlError(text(reply.error) || "AnythingLLM sent no job");
  return job;
}

const pathOf = (job: number): string => `/scheduled-jobs/${jobId(job)}`;

export class Jobs {
  readonly #api: Anything;

  constructor(api: Anything) {
    this.#api = api;
  }

  async listing(): Promise<Obj> {
    return { timezone: "UTC", jobs: (await this.#all()).map(shown) };
  }

  async add(spec: JobSpec, apply: boolean): Promise<Obj> {
    const name = checkedName(spec.name);
    const prompt = checkedPrompt(spec.prompt);
    const schedule = checkedSchedule(spec.schedule);
    const tools = await this.#usable(checkedTools(spec.tools));
    const wanted: Obj = { name, prompt, schedule, tools: tools ?? [] };
    const existing = (await this.#all()).map(shown);
    const twin = existing.find((j) => Object.entries(wanted).every(([k, v]) => same(j[k], v)));
    if (twin) throw new ControlError(`an identical job already exists (id ${twin.id})`);
    if (!apply) {
      const alike = existing.filter((j) => text(j.name).toLowerCase() === name.toLowerCase()).map((j) => j.id);
      return { applied: false, would_add: wanted, note: UTC, same_name: alike };
    }
    const reply = obj(await this.#api.call("POST", "/scheduled-jobs/new", { name, prompt, tools: tools ?? null, schedule }));
    return { applied: true, job: shown(made(reply)) };
  }

  async update(job: number, edit: JobEdit, apply: boolean): Promise<Obj> {
    const changes: Obj = {};
    if (edit.name !== undefined) changes.name = checkedName(edit.name);
    if (edit.prompt !== undefined) changes.prompt = checkedPrompt(edit.prompt);
    if (edit.schedule !== undefined) changes.schedule = checkedSchedule(edit.schedule);
    if (edit.tools !== undefined) changes.tools = await this.#usable(checkedTools(edit.tools));
    if (edit.enabled !== undefined) changes.enabled = edit.enabled;
    if (!Object.keys(changes).length) throw new ControlError("say what to change: name, prompt, schedule, tools or enabled");
    const current = shown(await this.#one(job));
    const differing = Object.fromEntries(Object.entries(changes).filter(([k, v]) => !same(current[k], v)).map(([k, v]) => [k, { from: current[k], to: v }]));
    if (!Object.keys(differing).length) return { applied: false, job: current.id, note: "the job already is so" };
    if (!apply) return { applied: false, job: current.id, name: current.name, changes: differing, note: UTC };
    const reply = obj(await this.#api.call("PUT", pathOf(job), changes));
    return { applied: true, job: shown(made(reply)) };
  }

  async delete(job: number, apply: boolean): Promise<Obj> {
    const current = shown(await this.#one(job));
    if (!apply) return { applied: false, would_delete: current };
    const reply = obj(await this.#api.call("DELETE", pathOf(job)));
    if (reply.success !== true) throw new ControlError(`AnythingLLM has no job ${job}`);
    return { applied: true, deleted: current.id, name: current.name };
  }

  /** `tools`, when AnythingLLM's catalog has each, set up (as its own create-scheduled-job checks):
   *  a job with an id it doesn't know runs without that tool. */
  async #usable(tools: string[] | undefined): Promise<string[] | undefined> {
    if (!tools?.length) return tools;
    const catalog = items(obj(await this.#api.call("GET", "/scheduled-jobs/available-tools")).tools).map(obj);
    const ready = catalog.filter((c) => !c.requiresSetup).flatMap((c) => items(c.items).map(obj).filter((t) => !t.requiresSetup).map((t) => text(t.id)));
    const unknown = tools.filter((t) => !ready.includes(t));
    if (!unknown.length) return tools;
    const meant = unknown.filter((t) => ready.includes(`@@${t}`)).map((t) => ` (an imported skill is @@${t})`).join("");
    throw new ControlError(`a job can't use ${unknown.join(", ")}${meant}; it can use ${ready.join(", ")}`);
  }

  async #all(): Promise<Obj[]> {
    return items(obj(await this.#api.call("GET", "/scheduled-jobs")).jobs).map(obj);
  }

  async #one(job: number): Promise<Obj> {
    return made(obj(await this.#api.call("GET", pathOf(job))));
  }
}
