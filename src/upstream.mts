// AnythingLLM, from here: its internal API (`<ANYTHINGLLM_URL>/api`), the one its own pages use,
// for what the developer API (/api/v1) doesn't have; and the developer API only to ask whether a
// client's key is good.
//
// It logs in as the pages do: `POST /api/request-token` with the password, which is AUTH_TOKEN: in
// AnythingLLM's .env for the bridge (ANYTHINGLLM_ENV), in the environment for a process AnythingLLM
// starts itself (the control server). It is read afresh at each login so a changed password needs
// no restart. The token is kept and the login made again after a 401. With no password set,
// AnythingLLM asks for none, and none is sent. Multi-user mode isn't supported. No error text holds
// a token or a key.

import crypto from "node:crypto";
import { upstream as upstreamError } from "./errors.mts";
import { readEnv } from "./envfile.mts";

/** AnythingLLM's port when SERVER_PORT doesn't say another (versions.env INNER_PORT). */
export const ANYTHINGLLM_PORT = 3001;
const DEFAULT_TIMEOUT = 30_000; // how long a call to AnythingLLM may take, in ms
const KEY_TIMEOUT = 10_000; // and the question about a key
const OK_FOR = 60_000; // a key AnythingLLM took is remembered this long (ms)
const BAD_FOR = 10_000; // and one it refused, this long
const MAX_KEYS = 256; // keys remembered; clients can send any key, so the memory has a bound

interface Reply {
  status: number;
  /** null when the body is empty or isn't JSON. */
  json: unknown;
}

interface Options {
  method?: string;
  body?: unknown;
  token?: string;
  timeout?: number;
  /** Aborts the call (the client that asked for it left). An aborted call throws the AbortError as it is. */
  signal?: AbortSignal;
}

/** The reason an answer gives, its `error` or `message`, or null. */
export const said = (found: unknown): string | null => {
  const f = found as { error?: unknown; message?: unknown } | null;
  const reason = f && typeof f === "object" ? f.error || f.message : null;
  return reason && reason !== true ? String(reason) : null;
};

/** One JSON call: its status and its JSON. */
export async function request(url: string, { method = "GET", body, token = "", timeout = DEFAULT_TIMEOUT, signal }: Options = {}): Promise<Reply> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  let text: string;
  try {
    const limit = signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout);
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: limit });
    text = await res.text();
  } catch (e) {
    if (signal?.aborted) throw e;
    if ((e as Error).name === "TimeoutError") throw upstreamError(`AnythingLLM didn't answer within ${Math.round(timeout / 1000)} s`);
    throw upstreamError(`AnythingLLM can't be reached: ${((e as Error).cause as Error | undefined)?.message ?? (e as Error).message}`);
  }
  try {
    return { status: res.status, json: text.trim() ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, json: null };
  }
}

/** The JSON of a 2xx reply; any other status is a 502 saying AnythingLLM's own reason when it gave one. */
export function expect({ status, json }: Reply): unknown {
  if (status < 300) return json;
  const reason = said(json);
  throw upstreamError(`AnythingLLM answered ${status}${reason ? `: ${reason}` : ""}`);
}

/** Where the password comes from: `read` gives it (empty for none), `where` names it in errors. */
export interface Password {
  read: () => string;
  where: string;
}

/** The password in an .env file, as AUTH_TOKEN. */
export const passwordIn = (envFile: string): Password => ({ read: () => readEnv(envFile).AUTH_TOKEN || "", where: `the password in ${envFile}` });

interface Held {
  ok: Promise<boolean>;
  /** Infinity while the question is out. */
  until: number;
}

export class Upstream {
  readonly #base: string;
  readonly #password: Password | null;
  readonly #now: () => number;
  #token: Promise<string> | null = null;
  #seen = new Map<string, Held>();

  /** `password` is null for none. */
  constructor(baseUrl: string, password: Password | null, now: () => number = () => performance.now()) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#password = password;
    this.#now = now;
  }

  /** The bridge's view of AnythingLLM: its address and the .env that holds the password. */
  static of(settings: { anythingllmUrl: string; envFile: string | null }): Upstream {
    return new Upstream(settings.anythingllmUrl, settings.envFile ? passwordIn(settings.envFile) : null);
  }

  async #login(): Promise<string> {
    const password = this.#password?.read() ?? "";
    if (!password) return "";
    const { status, json } = await request(`${this.#base}/api/request-token`, { method: "POST", body: { password } });
    const token = (json as { token?: unknown } | null)?.token;
    if (status !== 200 || !token) {
      throw upstreamError(`AnythingLLM refused the login with ${this.#password?.where}: ${said(json) ?? status}`);
    }
    return String(token);
  }

  /** The token, logging in first when there is none, or when `stale` (the one a call just had refused)
   *  is still the one kept. Calls made at once share one login. */
  #tokenFor(stale?: Promise<string>): Promise<string> {
    if (!this.#token || this.#token === stale) {
      const login = this.#login();
      this.#token = login;
      login.catch(() => {
        if (this.#token === login) this.#token = null; // a failed login is tried again
      });
    }
    return this.#token;
  }

  /** The status and JSON of AnythingLLM's own answer, whatever its status. `path` is under /api.
   *  `signal` ends the call early; the login it may wait on is shared and goes on. */
  async exchange(method: string, path: string, body?: unknown, timeout = DEFAULT_TIMEOUT, signal?: AbortSignal): Promise<Reply> {
    const url = `${this.#base}/api${path}`;
    const first = this.#tokenFor();
    const token = await first;
    const reply = await request(url, { method, body, token, timeout, signal });
    if (reply.status !== 401 || !token) return reply; // with no password, a 401 is the route's own
    const again = await request(url, { method, body, token: await this.#tokenFor(first), timeout, signal });
    if (again.status === 401) throw upstreamError(`AnythingLLM refused the login (${this.#password?.where ?? "no password"})`);
    return again;
  }

  /** Whether AnythingLLM takes a developer key (`GET /api/v1/auth`), remembered OK_FOR ms when it
   *  does and BAD_FOR when it doesn't. Calls made at once with one key share one question. */
  keyValid(key: string): Promise<boolean> {
    if (!key) return Promise.resolve(false);
    const digest = crypto.createHash("sha256").update(key).digest("hex");
    const held = this.#seen.get(digest);
    if (held && held.until > this.#now()) return held.ok;
    if (this.#seen.size >= MAX_KEYS) this.#forget();
    const entry: Held = { ok: Promise.resolve(false), until: Infinity };
    entry.ok = request(`${this.#base}/api/v1/auth`, { token: key, timeout: KEY_TIMEOUT }).then(({ status }) => {
      if (status >= 500) throw upstreamError(`AnythingLLM answered ${status} when asked about a key`);
      entry.until = this.#now() + (status === 200 ? OK_FOR : BAD_FOR);
      return status === 200;
    });
    entry.ok.catch(() => {
      if (this.#seen.get(digest) === entry) this.#seen.delete(digest); // an unanswered question is asked again
    });
    this.#seen.set(digest, entry);
    return entry.ok;
  }

  /** Makes room: drops what has expired, and if that is nothing, the oldest. */
  #forget(): void {
    const now = this.#now();
    for (const [k, v] of this.#seen) if (v.until <= now) this.#seen.delete(k);
    if (this.#seen.size >= MAX_KEYS) this.#seen.delete(this.#seen.keys().next().value as string);
  }
}
