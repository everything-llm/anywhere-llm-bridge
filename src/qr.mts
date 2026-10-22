// The pairing link as a QR code a terminal can show, for Lite's Settings > Connection > Scan QR
// code. Two modules per character (the upper half block, its foreground the upper module and its
// background the lower), in explicit black and white so it scans on a dark theme as on a light one.

import qrcode from "qrcode-generator";

const QUIET = 4; // modules of light border on each side, as the standard asks
const DARK = { fg: 30, bg: 40 };
const LIGHT = { fg: 97, bg: 107 };

/** `text` as a QR code (error correction M) in ANSI-coloured lines, one per two rows of modules. */
export function terminalQr(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  const dark = (row: number, col: number) =>
    row >= 0 && col >= 0 && row < size && col < size && code.isDark(row, col);
  const lines: string[] = [];
  for (let row = -QUIET; row < size + QUIET; row += 2) {
    let line = "";
    for (let col = -QUIET; col < size + QUIET; col++) {
      const top = dark(row, col) ? DARK : LIGHT;
      const bottom = dark(row + 1, col) ? DARK : LIGHT;
      line += `\x1b[${top.fg};${bottom.bg}m▀`;
    }
    lines.push(line + "\x1b[0m");
  }
  return lines.join("\n");
}
