// The control server's settings, from its environment. AnythingLLM starts it with its own
// environment (the hypervisor passes `process.env`, the entry's `env` over it), so AnythingLLM's
// port and password are already there:
//
//   ANYTHINGLLM_URL        AnythingLLM (default http://127.0.0.1:<SERVER_PORT, else 3001>)
//   AUTH_TOKEN             its password; none for a Desktop or an open instance
//   ANYTHINGLLM_MCP_ROLES  comma-separated, from `chat` and `schedule` (default `chat`)

import type { Env } from "../paths.mts";
import { ANYTHINGLLM_PORT } from "../upstream.mts";

/** The roles a server can be given, those it has without being asked, and the variable that names them
 *  (`install --control --roles` writes it into the entry). */
export const ROLES = ["chat", "schedule"];
export const DEFAULT_ROLES = ["chat"];
export const ROLES_ENV = "ANYTHINGLLM_MCP_ROLES";

/** AnythingLLM's address: ANYTHINGLLM_URL, else this machine at its own SERVER_PORT, else 3001. */
const anythingllmUrl = (env: Env): string =>
  (env.ANYTHINGLLM_URL || `http://127.0.0.1:${env.SERVER_PORT || ANYTHINGLLM_PORT}`).replace(/\/+$/, "");
export interface Settings {
  url: string;
  roles: string[];
}

/** The roles `text` names (comma-separated, each once); one that does not exist throws, saying which do. `what` names the source. */
export function parseRoles(text: string, what: string): string[] {
  const asked = text.split(",").map((r) => r.trim());
  const roles = [...new Set(asked.filter(Boolean))];
  if (!roles.length || !roles.every((r) => ROLES.includes(r))) throw new Error(`${what} is one or more of ${ROLES.join(", ")}; got ${JSON.stringify(asked)}`);
  return roles;
}

/** The settings. */
export function fromEnv(env: Env): Settings {
  return { url: anythingllmUrl(env), roles: parseRoles(env[ROLES_ENV] ?? DEFAULT_ROLES.join(","), ROLES_ENV) };
}
