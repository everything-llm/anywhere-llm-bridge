import assert from "node:assert/strict";
import { test } from "node:test";
import { pairingLink, phoneUrl, privateHost } from "../src/pair.mts";

const PRIVATE = [
  "localhost", "LOCALHOST", "nas", "printer.local", "gir.lan", "box.home.arpa", "gir.tail1234.ts.net", "gir.tail1234.ts.net.",
  "127.0.0.1", "127.8.9.10", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.20", "169.254.3.4", "100.64.0.1", "100.127.255.254",
  "::1", "[::1]", "fd12:3456::1", "fc00::1", "fe80::1", "fe80::1%eth0",
];
const PUBLIC = ["", "example.com", "ai.example.com", "localhost.example.com", "ts.net.example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1", "2001:4860::8888"];

test("a private host", () => {
  for (const host of PRIVATE) assert.ok(privateHost(host), host);
});

test("a public host", () => {
  for (const host of PUBLIC) assert.ok(!privateHost(host), JSON.stringify(host));
});

test("the link holds the address and the key", () => {
  assert.equal(pairingLink("https://host.example:3001", "K-1"), "anywherellm://connect?url=https%3A%2F%2Fhost.example%3A3001&key=K-1");
});

test("the link adds the bridge's and the apps' addresses in order", () => {
  assert.equal(
    pairingLink("https://ai.example.com", "K", "http://nas:8467", "https://apps.example.com"),
    "anywherellm://connect?url=https%3A%2F%2Fai.example.com&key=K&toolkit=http%3A%2F%2Fnas%3A8467&apps=https%3A%2F%2Fapps.example.com",
  );
  assert.equal(pairingLink("https://ai.example.com", "K", null, ""), "anywherellm://connect?url=https%3A%2F%2Fai.example.com&key=K");
});

test("an address loses its whitespace and trailing slash", () => {
  assert.equal(phoneUrl(" https://ai.example.com// "), "https://ai.example.com");
  assert.equal(
    pairingLink(" http://nas:3001/", "K", undefined, "https://apps.example.com/ "),
    "anywherellm://connect?url=http%3A%2F%2Fnas%3A3001&key=K&apps=https%3A%2F%2Fapps.example.com",
  );
});

test("plain http is allowed to a private host", () => {
  for (const url of ["http://192.168.1.2:3001", "http://localhost:3001", "http://gir.tail1.ts.net:3001"]) {
    assert.ok(pairingLink(url, "K").startsWith("anywherellm://connect?url=http%3A%2F%2F"), url);
  }
});

test("a public http address is refused", () => {
  const cases: [string, string?, string?][] = [
    ["http://host.example:3001"],
    ["https://ai.example.com", "http://bridge.example.com"],
    ["https://ai.example.com", undefined, "http://8.8.8.8:8466"],
    ["ftp://nas"],
    ["https://"],
  ];
  for (const [url, bridge, apps] of cases) assert.throws(() => pairingLink(url, "K", bridge, apps), /over http only on a private network/, url);
});
