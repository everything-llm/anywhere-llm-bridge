// Waits for a condition that another part of the test brings about.
import { setTimeout as sleep } from "node:timers/promises";

export async function until(condition: () => unknown, ms = 2000): Promise<void> {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited >= ms) throw new Error("the condition did not come about");
    await sleep(10);
  }
}
