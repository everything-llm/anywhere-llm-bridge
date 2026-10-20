// The fence's asks: what a suite skill asks the person before it reaches a host on their own
// network, and the hosts they always allow. The skills run inside AnythingLLM and can't reach the
// bridge, so the two share AnythingLLM's storage folder, `<storage>/fence-lean/`:
//
//   asks/<id>.json   {id, host, origin, skill, workspace, why, asked, expires, decision, decided},
//                    written by the skill, which waits for `decision` and removes the file
//   allowed.json     {hosts: [{host, added}]}, which every skill reads beside FENCE_ALLOW
//
// The bridge only reads an ask and writes its decision, under the same lock folders the suite's
// `updateJson` takes. An id is 32 hex digits and a host a bare name or address, so no path leaves
// the folder.

import path from "node:path";
import fs from "node:fs";
import { invalid, conflict, notFound } from "./errors.mts";
import { locked, readJson, updateJson, writeJson } from "./atomic.mts";

/** What the person decides: this host for the rest of the answer, from now on, or not. */
export const DECISIONS = ["once", "always", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

export interface Ask {
  id: string;
  host: string;
  origin: string;
  skill: string;
  workspace: string;
  why: string;
  asked: string;
  expires: string;
  decision: Decision | null;
  decided: string | null;
}

export interface Allowed {
  host: string;
  added: string;
}

const ID = /^[0-9a-f]{32}$/;
// A host name (labels of letters, digits and hyphens) or an IPv4 or IPv6 address, as the fence
// compares it: lower case, no port, no brackets, no zone.
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|[0-9a-f:.]*:[0-9a-f:.]*)$/;

/** `id` when it is one, else a 400. */
export function checkId(id: string): string {
  if (!ID.test(id)) throw invalid("an ask's id is 32 hex digits");
  return id;
}

/** `host` lower-cased when it is a bare name or address, else a 400. */
export function checkHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!host || host.length > 253 || !HOST.test(host)) throw invalid(`${JSON.stringify(raw.slice(0, 100))} isn't a host name or address`);
  return host;
}

/** `decision` when it is one, else a 400. */
export function checkDecision(raw: unknown): Decision {
  if (typeof raw === "string" && (DECISIONS as readonly string[]).includes(raw)) return raw as Decision;
  throw invalid(`decision is one of ${DECISIONS.join(", ")}`);
}

export class Asks {
  readonly #dir: string;
  readonly #now: () => Date;

  /** `dir` is `<storage>/fence-lean`. */
  constructor(dir: string, now: () => Date = () => new Date()) {
    this.#dir = dir;
    this.#now = now;
  }

  #askFile = (id: string): string => path.join(this.#dir, "asks", `${checkId(id)}.json`);
  get #allowedFile(): string {
    return path.join(this.#dir, "allowed.json");
  }

  /** The ask, or a 404. */
  get(id: string): Ask {
    const ask = readJson<Ask | null>(this.#askFile(id), () => null);
    if (!ask) throw notFound("no such ask: it was answered, or the skill stopped waiting");
    return ask;
  }

  /** Writes the person's decision to the ask, and for `always` adds its host to the allowed ones.
   *  A 409 when it is decided already or expired, a 404 when it is gone. */
  async decide(id: string, decision: Decision): Promise<Ask> {
    const file = this.#askFile(id);
    const ask = await locked(`${file}.lock`, "the ask", () => {
      if (!fs.existsSync(file)) throw notFound("no such ask: it was answered, or the skill stopped waiting");
      const found = readJson<Ask>(file, () => {
        throw notFound("no such ask");
      });
      if (found.decision) throw conflict(`this ask was answered already: ${found.decision}`);
      const now = this.#now();
      if (!(Date.parse(found.expires) > now.getTime())) throw conflict("this ask expired; the skill went on without it");
      found.decision = decision;
      found.decided = now.toISOString();
      writeJson(file, found);
      return found;
    });
    if (decision === "always") await this.#allow(checkHost(ask.host));
    return ask;
  }

  /** The hosts always allowed. */
  allowed(): Allowed[] {
    return readJson<{ hosts?: Allowed[] }>(this.#allowedFile, () => ({ hosts: [] })).hosts ?? [];
  }

  async #allow(host: string): Promise<void> {
    await updateJson(this.#allowedFile, () => ({ hosts: [] as Allowed[] }), (value) => {
      value.hosts ??= [];
      if (!value.hosts.some((h) => h.host === host)) value.hosts.push({ host, added: this.#now().toISOString() });
    });
  }

  /** Takes `host` off the allowed ones and answers those left; a 404 when it isn't one. */
  forget(raw: string): Promise<Allowed[]> {
    const host = checkHost(raw);
    return updateJson(this.#allowedFile, () => ({ hosts: [] as Allowed[] }), (value) => {
      const left = (value.hosts ?? []).filter((h) => h.host !== host);
      if (left.length === (value.hosts ?? []).length) throw notFound(`${host} isn't always allowed`);
      value.hosts = left;
      return left;
    });
  }
}
