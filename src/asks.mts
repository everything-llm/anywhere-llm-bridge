// The fence's asks: what a suite skill asks the person before it reaches an address on their own
// network, and the addresses they always allow. The skills run inside AnythingLLM and can't reach the
// bridge, so the two share AnythingLLM's storage folder, `<storage>/fence-lean/`:
//
//   asks/<id>.json   {id, host, origin, skill, workspace, why, asked, expires, decision, decided},
//                    written by the skill, which waits for `decision` and removes the file
//   allowed.json     {origins: [{origin, added}]}, which every skill reads beside FENCE_ALLOW
//
// An allowed address is one origin (scheme, host and port), so allowing a server on one port
// leaves the machine's other ports asking. The bridge only reads an ask and writes its decision,
// under the same lock folders the suite's `updateJson` takes. An id is 32 hex digits, so no path
// leaves the folder.

import path from "node:path";
import { invalid, conflict, notFound } from "./errors.mts";
import { readJson, updateJson } from "./atomic.mts";

/** What the person decides: this address for the rest of the answer, from now on, or not. */
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
  origin: string;
  added: string;
}

const ID = /^[0-9a-f]{32}$/;

/** `id` when it is one, else a 400. */
export function checkId(id: string): string {
  if (!ID.test(id)) throw invalid("an ask's id is 32 hex digits");
  return id;
}

/** `raw`'s origin as `URL.origin` writes it, for http and https; else null. The same rule as
 *  anywherellm-suite's fence (`originOf`, packages/shared/fence.mts), which writes what the skills
 *  ask for. */
function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

/** `raw` when it is an origin as `URL.origin` writes it: an http or https scheme, a lower-case host
 *  and a port only when it isn't the default; else a 400. */
export function checkOrigin(raw: string): string {
  const s = raw.trim();
  if (originOf(s) !== s) throw invalid(`${JSON.stringify(raw.slice(0, 100))} isn't an address: an http or https scheme, a host and a port, nothing else`);
  return s;
}

/** `decision` when it is one, else a 400. */
export function checkDecision(raw: unknown): Decision {
  if (typeof raw === "string" && (DECISIONS as readonly string[]).includes(raw)) return raw as Decision;
  throw invalid(`decision is one of ${DECISIONS.join(", ")}`);
}

/** An ask that isn't there: a 404. */
function gone(): never {
  throw notFound("no such ask: it was answered, or the skill stopped waiting");
}

type AllowedFile = { origins: Allowed[] };
const noOrigins = (): AllowedFile => ({ origins: [] });

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
    return readJson<Ask>(this.#askFile(id), gone);
  }

  /** Writes the person's decision to the ask, and for `always` adds its origin to the allowed ones.
   *  A 409 when it is decided already or expired, a 404 when it is gone. */
  async decide(id: string, decision: Decision): Promise<Ask> {
    let origin = "";
    const ask = await updateJson<Ask, Ask>(this.#askFile(id), gone, (found) => {
      if (found.decision) throw conflict(`this ask was answered already: ${found.decision}`);
      const now = this.#now();
      if (!(Date.parse(found.expires) > now.getTime())) throw conflict("this ask expired; the skill went on without it");
      if (decision === "always") origin = checkOrigin(found.origin);
      found.decision = decision;
      found.decided = now.toISOString();
      return found;
    });
    if (decision === "always") await this.#allow(origin);
    return ask;
  }

  /** The addresses always allowed. */
  allowed(): Allowed[] {
    return readJson(this.#allowedFile, noOrigins).origins ?? [];
  }

  async #allow(origin: string): Promise<void> {
    await updateJson(this.#allowedFile, noOrigins, (value) => {
      const origins = (value.origins ??= []);
      if (!origins.some((o) => originOf(o.origin) === origin)) origins.push({ origin, added: this.#now().toISOString() });
    });
  }

  /** Takes `origin` off the allowed ones and answers those left; a 404 when it isn't one. An entry
   *  is compared as its origin (originOf), so one written another way (` HTTP://Host:80`) still goes. */
  forget(raw: string): Promise<Allowed[]> {
    const origin = checkOrigin(raw);
    return updateJson(this.#allowedFile, noOrigins, (value) => {
      const origins = (value.origins ??= []);
      const left = origins.filter((o) => originOf(o.origin) !== origin);
      if (left.length === origins.length) throw notFound(`${origin} isn't always allowed`);
      value.origins = left;
      return left;
    });
  }
}
