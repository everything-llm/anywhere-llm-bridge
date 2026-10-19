// What isn't the public internet, by address or by name: the rules a phone's plain-http address
// is held to (pair.mts). The same rules as anywherellm-suite's fence (packages/shared/fence.mts).

import net from "node:net";

const PRIVATE = new net.BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, and Tailscale's addresses
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, and cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const) {
  PRIVATE.addSubnet(address, bits, "ipv4");
}
for (const [address, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(address, bits, "ipv6"); // :: and ::1, unique-local, link-local, multicast

/** Whether `ip` (an IPv4 or IPv6 address, an IPv6 zone allowed) is outside the public internet. */
export function privateAddress(ip: string): boolean {
  const bare = ip.split("%", 1)[0];
  const kind = net.isIP(bare);
  return kind ? PRIVATE.check(bare, kind === 6 ? "ipv6" : "ipv4") : true;
}

/** Whether a host name, by its name alone, is one of this machine's or this network's. */
export function privateName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name.includes(".")) return true; // a single label: a container, a LAN machine
  return /(^|\.)(localhost|local|internal|lan|home\.arpa|ts\.net)$/.test(name);
}

