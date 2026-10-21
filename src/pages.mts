// Where AnywhereLLM Lite opens the suite's Library and Vault pages (`GET /pages`). The suite's skills
// keep the two pages' root-relative paths in `<storage>/anywherellm-suite/page-links.json`,
// `{library?, vault?, rotated?}` (the suite's docs/page-links.md is the contract). Code in
// AnythingLLM's container can write that file, so a path is answered only when it has exactly the
// shape the suite writes, `/library-lean/<token>.html` or `/vault-lean/<token>.html` with a token of
// 24 base64url characters; anything else, a file that isn't there or can't be read, is null for that
// page, never an error, and the value is never shown. A path is a bearer capability (the page embeds
// its event secret), so it is never logged. The file is read at each call, so a rotation shows at once.

import fs from "node:fs";
import path from "node:path";

export interface PageLinks {
  library: string | null;
  vault: string | null;
}

const SHAPES: Record<keyof PageLinks, RegExp> = {
  library: /^\/library-lean\/[A-Za-z0-9_-]{24}\.html$/,
  vault: /^\/vault-lean\/[A-Za-z0-9_-]{24}\.html$/,
};

/** Opening a link fails (ELOOP) instead of following it, and opening a pipe doesn't wait for a
 *  writer; Windows has neither flag. */
const OPEN = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
/** The most the links file is read to; it holds a few hundred bytes. */
const MAX_JSON = 64 * 1024;

/** What the JSON file `file` holds, or null when it isn't a plain file of at most MAX_JSON bytes
 *  holding JSON: a link could point at any file of the host's, and a pipe or a device could hold the
 *  read up for ever. */
function readPlainJson(file: string): unknown {
  let fd: number;
  try {
    fd = fs.openSync(file, OPEN);
  } catch {
    return null; // none, or a link
  }
  try {
    const stat = fs.fstatSync(fd);
    return stat.isFile() && stat.size <= MAX_JSON ? JSON.parse(fs.readFileSync(fd, "utf8")) : null;
  } catch {
    return null; // bad JSON
  } finally {
    fs.closeSync(fd);
  }
}

/** The two pages' paths in AnythingLLM's storage `storage`, each null unless it is one. */
export function readPages(storage: string): PageLinks {
  const found = readPlainJson(path.join(storage, "anywherellm-suite", "page-links.json"));
  const links = found !== null && typeof found === "object" ? (found as Record<string, unknown>) : {};
  const pathOf = (kind: keyof PageLinks): string | null => {
    const value = links[kind];
    return typeof value === "string" && SHAPES[kind].test(value) ? value : null;
  };
  return { library: pathOf("library"), vault: pathOf("vault") };
}
