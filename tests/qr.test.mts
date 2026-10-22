import assert from "node:assert/strict";
import { test } from "node:test";
import qrcode from "qrcode-generator";
import { terminalQr } from "../src/qr.mts";

const LINK = "anywherellm://connect?url=https%3A%2F%2Fgir.tail1234.ts.net%3A3001&key=ABCD123-EFGH456-IJKL789-MNOP012&toolkit=https%3A%2F%2Fgir.tail1234.ts.net%3A8467";
const HALVES: Record<string, [boolean, boolean]> = { "█": [false, false], "▀": [false, true], "▄": [true, false], " ": [true, true] };

test("each line, white on black, draws the code's modules inside a light border of 4", () => {
  const code = qrcode(0, "M");
  code.addData(LINK);
  code.make();
  const size = code.getModuleCount();
  const drawn: boolean[][] = []; // true = dark
  for (const line of terminalQr(LINK).split("\n")) {
    const inner = line.match(/^\x1b\[97;40m(.*)\x1b\[0m$/)?.[1];
    assert.ok(inner !== undefined, "white on black, reset at the end");
    const cells = [...inner].map((c) => HALVES[c]);
    drawn.push(cells.map(([top]) => top), cells.map(([, bottom]) => bottom));
  }
  assert.equal(drawn[0].length, size + 8);
  for (let row = 0; row < size + 8; row++) {
    for (let col = 0; col < size + 8; col++) {
      const r = row - 4, c = col - 4;
      assert.equal(drawn[row][col], r >= 0 && c >= 0 && r < size && c < size && code.isDark(r, c), `module ${r},${c}`);
    }
  }
});
