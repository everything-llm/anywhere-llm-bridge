import fs from "fs";
import path from "path";
import { forbidden } from "./errors.mts";

/** Writes `data` to `file` atomically, making its folder: a reader never sees half of it. The file
 *  is a new one renamed over the old, so a link there is replaced, never followed; `mode` is set
 *  whatever the umask. */
export function writeAtomic(file: string, data: string | Uint8Array, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode, flag: "wx" });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
}

/** Whether `file` holds exactly `text`; false when there is no file. */
export const sameText = (file: string, text: string): boolean => fs.existsSync(file) && fs.readFileSync(file, "utf8") === text;

/** Writes `text` to `file` atomically unless it holds it already; whether it wrote. */
export function writeAtomicIfChanged(file: string, text: string, mode?: number): boolean {
  if (sameText(file, text)) return false;
  writeAtomic(file, text, mode);
  return true;
}

/** Opening a link fails (ELOOP) instead of following it; Windows has no such flag. */
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** What the JSON file `file` holds, or `fresh()` when there's none. A file that can't be parsed is an
 *  error, never taken for an empty one: a change would write over what it held. A link is refused,
 *  a 403: whoever can write the folder (the container) could point it at any file of the host's. */
export function readJson<S>(file: string, fresh: () => S): S {
  let text: string;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    try {
      text = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fresh();
    if (code === "ELOOP") throw forbidden(`${path.basename(file)} is a link; only the file itself is read`);
    throw e;
  }
  return JSON.parse(text) as S;
}
