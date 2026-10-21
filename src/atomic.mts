import fs from "fs";
import path from "path";
import { forbidden, tooLarge } from "./errors.mts";

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

/** Opening a link fails (ELOOP) instead of following it, and opening a pipe doesn't wait for a
 *  writer; Windows has neither flag. */
const OPEN = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
/** The most readJson reads; the files it reads hold a few hundred bytes. */
const MAX_JSON = 64 * 1024;

/** What the JSON file `file` holds, or `fresh()` when there's none; a file that can't be parsed is an
 *  error. Whoever can write the folder (the container) could put anything there, so only a plain
 *  file of at most MAX_JSON bytes is read: a link is a 403 (it could point at any file of the
 *  host's), and so is a pipe or a device (it could hold the read up for ever). */
export function readJson<S>(file: string, fresh: () => S): S {
  const name = path.basename(file);
  let fd: number;
  try {
    fd = fs.openSync(file, OPEN);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fresh();
    if (code === "ELOOP") throw forbidden(`${name} is a link; only the file itself is read`);
    throw e;
  }
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw forbidden(`${name} isn't a plain file`);
    if (stat.size > MAX_JSON) throw tooLarge(`${name} is over ${MAX_JSON} bytes`);
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  return JSON.parse(text) as S;
}
