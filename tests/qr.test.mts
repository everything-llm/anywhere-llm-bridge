import assert from "node:assert/strict";
import { test } from "node:test";
import qrcode from "qrcode-generator";
import { terminalQr } from "../src/qr.mts";

const LINK = "anywherellm://connect?url=https%3A%2F%2Fgir.tail1234.ts.net%3A3001&key=ABCD123-EFGH456-IJKL789-MNOP012&toolkit=https%3A%2F%2Fgir.tail1234.ts.net%3A8467";

/** The modules the lines draw, read back from each character's colours (true = dark). */
function modules(qr: string): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of qr.split("\n")) {
    const cells = [...line.matchAll(/\x1b\[(\d+);(\d+)m▀/g)];
    rows.push(cells.map(([, fg]) => fg === "30"), cells.map(([, , bg]) => bg === "40"));
  }
  return rows;
}

test("the lines draw the code's modules inside a light border of 4", () => {
  const code = qrcode(0, "M");
  code.addData(LINK);
  code.make();
  const size = code.getModuleCount();
  const drawn = modules(terminalQr(LINK));
  const width = size + 8;
  assert.equal(drawn[0].length, width);
  assert.equal(drawn.length, width + (width % 2)); // an odd height ends on a light half row
  for (let row = 0; row < drawn.length; row++) {
    for (let col = 0; col < width; col++) {
      const r = row - 4, c = col - 4;
      const inside = r >= 0 && c >= 0 && r < size && c < size;
      assert.equal(drawn[row][col], inside && code.isDark(r, c), `module ${r},${c}`);
    }
  }
});

test("each line ends by resetting the colours, and the corners hold finder patterns", () => {
  const qr = terminalQr(LINK);
  for (const line of qr.split("\n")) assert.ok(line.endsWith("\x1b[0m"));
  const drawn = modules(qr);
  const finder = (top: number, left: number) =>
    [0, 1, 2, 3, 4, 5, 6].every((i) => drawn[top][left + i] && drawn[top + 6][left + i] && drawn[top + i][left] && drawn[top + i][left + 6]);
  const far = drawn[0].length - 4 - 7;
  assert.ok(finder(4, 4) && finder(4, far) && finder(far, 4));
});
