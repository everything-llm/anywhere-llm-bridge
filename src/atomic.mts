import fs from "fs";
import path from "path";

/** Writes `data` to `file` atomically, making its folder: a reader never sees half of it. */
export function writeAtomic(file: string, data: string | Uint8Array, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode });
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
}

/** Writes `text` to `file` atomically unless it holds it already; whether it wrote. */
export function writeAtomicIfChanged(file: string, text: string, mode?: number): boolean {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return false;
  writeAtomic(file, text, mode);
  return true;
}

