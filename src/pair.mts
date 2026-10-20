// What a phone connects with. AnywhereLLM Lite takes a link holding AnythingLLM's address and a
// developer key, and the bridge's and anythingllm-apps-v2's addresses when they are known:
// `anywherellm://connect?url=...&key=...&toolkit=...&apps=...`. The link's `toolkit` field keeps its
// name: it is what the app reads. Plain http is allowed only to a private host.

import net from "node:net";
import { invalid, upstream as upstreamError } from "./errors.mts";
import { privateAddress, privateName } from "./private.mts";
import { expect, type Upstream } from "./upstream.mts";

/** The developer key the phones share, the one `pair` hands out; only it may decide asks. */
export const KEY_NAME = "AnywhereLLM";

/** True for a name of this machine or its network (localhost, a name with no dot such as `nas`, or
 *  one under .local, .lan, .internal, .home.arpa or .ts.net) and an address outside the public
 *  internet (loopback, private, link-local, Tailscale's): the fence's own rules (#shared/fence). */
export function privateHost(host: string): boolean {
  const name = host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!name) return false;
  return net.isIP(name.split("%", 1)[0]) ? privateAddress(name) : privateName(name);
}

/** `url` without surrounding whitespace or a trailing slash, when the phone may send its key
 *  there: https anywhere, or http to a private host. */
export function phoneUrl(url: string): string {
  const clean = url.trim().replace(/\/+$/, "");
  try {
    const { protocol, hostname } = new URL(clean);
    if (protocol === "https:" || (protocol === "http:" && privateHost(hostname))) return clean;
  } catch {
    // not an address: refused below
  }
  throw invalid(
    `the phone sends its key over https, or over http only on a private network (home, Tailscale or this device): not ${JSON.stringify(clean)}`,
  );
}

/** The text a phone connects with: AnythingLLM's address, the key, and the bridge's and the apps
 *  server's addresses when given, each checked by `phoneUrl`. */
export function pairingLink(url: string, key: string, bridge?: string | null, apps?: string | null): string {
  const fields = new URLSearchParams({ url: phoneUrl(url), key });
  if (bridge) fields.set("toolkit", phoneUrl(bridge));
  if (apps) fields.set("apps", phoneUrl(apps));
  return "anywherellm://connect?" + fields.toString();
}

interface Key {
  name?: string;
  secret?: string;
}

/** The secret of the developer key called KEY_NAME, made when there is none. Every phone shares
 *  KEY_NAME's, so deleting it in AnythingLLM's settings disconnects them all. */
export async function developerKey(api: Upstream): Promise<string> {
  const listed = (expect(await api.exchange("GET", "/system/api-keys")) as { apiKeys?: Key[] } | null)?.apiKeys ?? [];
  const found = listed.find((k) => k?.name === KEY_NAME && k.secret)?.secret;
  if (found) return found;
  const made = expect(await api.exchange("POST", "/system/generate-api-key", { name: KEY_NAME })) as { apiKey?: Key; error?: string } | null;
  if (!made?.apiKey?.secret) throw upstreamError(`AnythingLLM made no key${made?.error ? `: ${made.error}` : ""}`);
  return made.apiKey.secret;
}
