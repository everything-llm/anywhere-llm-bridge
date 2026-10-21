// Where AnywhereLLM Lite opens the suite's Library and Vault pages (`GET /pages`). The suite's skills
// keep the two pages' root-relative paths in `<storage>/anywherellm-suite/page-links.json`,
// `{library?, vault?, rotated?}` (the suite's docs/page-links.md is the contract). Code in
// AnythingLLM's container can write that file, so a path is answered only when it has exactly the
// shape the suite writes, `/library-lean/<token>.html` or `/vault-lean/<token>.html` with a token of
// 24 base64url characters; anything else, a file that isn't there or can't be read, is null for that
// page, never an error, and the value is never shown. A path is a bearer capability (the page embeds
// its event secret), so it is never logged. The file is read at each call, so a rotation shows at once.

import path from "node:path";
import { readJson } from "./atomic.mts";

export interface PageLinks {
  library: string | null;
  vault: string | null;
}

const SHAPES: Record<keyof PageLinks, RegExp> = {
  library: /^\/library-lean\/[A-Za-z0-9_-]{24}\.html$/,
  vault: /^\/vault-lean\/[A-Za-z0-9_-]{24}\.html$/,
};

/** The two pages' paths in AnythingLLM's storage `storage`, each null unless it is one. */
export function readPages(storage: string): PageLinks {
  let found: unknown = null;
  try {
    found = readJson<unknown>(path.join(storage, "anywherellm-suite", "page-links.json"), () => null);
  } catch {} // a link or bad JSON: no links
  const links = found !== null && typeof found === "object" ? (found as Record<string, unknown>) : {};
  const pathOf = (kind: keyof PageLinks): string | null => {
    const value = links[kind];
    return typeof value === "string" && SHAPES[kind].test(value) ? value : null;
  };
  return { library: pathOf("library"), vault: pathOf("vault") };
}
