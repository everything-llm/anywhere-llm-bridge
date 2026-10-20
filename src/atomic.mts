import fs from "fs";
import path from "path";
import { busy, forbidden } from "./errors.mts";

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


const LOCK_WAIT_MS = 5 * 1000;
const LOCK_STALE_MS = 10 * 1000;
const LOCK_RETRY_MS = 20;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** mkdir's answer for a lock folder that's there, or (Windows) still being removed. */
const isBusy = (code?: string) => code === "EEXIST" || (process.platform === "win32" && (code === "EPERM" || code === "EACCES"));
const queues = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier call with the same `key` in this process has ended. */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/** Runs `fn` holding the lock folder `lock`: one process at a time (the folder is made, or waited
 *  for), and in this process one call at a time. The suite's skills lock the same files the same
 *  way (its `shared/atomic.mts`), so the two never write over each other. A lock older than
 *  LOCK_STALE_MS is one a process left behind when it died, and is broken. `what` names what's
 *  locked in the 503 said when it stays busy. */
function locked<T>(lock: string, what: string, fn: () => T | Promise<T>): Promise<T> {
  return serial(`lock:${lock}`, async () => {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (e) {
        if (!isBusy((e as NodeJS.ErrnoException).code)) throw e;
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {} // released meanwhile, or still being removed
      if (Date.now() > until) throw busy(`${what} is busy; try again in a moment`);
      await sleep(LOCK_RETRY_MS);
    }
    try {
      return await fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  });
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

/** Writes `value` to the JSON file `file` as the suite does: indented, readable by its owner only. */
const writeJson = (file: string, value: unknown): void => writeAtomic(file, JSON.stringify(value, null, 2) + "\n", 0o600);

/** Changes the JSON file `file` under its lock (`file`.lock): `change` gets what it holds now (or
 *  `fresh` when there's none) and changes it in place; what it answers is answered. */
export function updateJson<S, T>(file: string, fresh: () => S, change: (value: S) => T): Promise<T> {
  return locked(`${file}.lock`, path.basename(file), () => {
    const value = readJson(file, fresh);
    const answer = change(value);
    writeJson(file, value);
    return answer;
  });
}
