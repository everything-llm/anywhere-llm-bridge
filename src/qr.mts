// The pairing link as a QR code a terminal can show, for Lite's Settings > Connection > Scan QR
// code. The encoder draws two modules per character, light ones as blocks and dark ones as spaces;
// each line is set in bright white on black so it scans on a dark theme as on a light one.

import qrcode from "qrcode-generator";

/** `text` as a QR code (error correction M, a light border of 4 modules) in ANSI-coloured lines. */
export function terminalQr(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  return code.createASCII(1, 4).split("\n").map((line) => `\x1b[97;40m${line}\x1b[0m`).join("\n");
}
