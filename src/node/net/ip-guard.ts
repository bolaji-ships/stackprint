// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SSRF guard: which IP addresses a public scanner must never connect to.
 *
 * Hostnames that are IP literals are checked before any connection; DNS names are checked at connect
 * time by the safe lookup (so a name cannot pass a check and then resolve somewhere else). The WHATWG URL
 * parser already normalises obfuscated IPv4 forms (2130706433, 0x7f000001, 0177.0.0.1) to dotted quads.
 */

import { BlockList, isIP } from "node:net";

const blocked = new BlockList();

const V4: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
];

const V6: [string, number][] = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];

for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, "ipv6");

/** Expand an IPv6 address into 8 numbers (handles "::" and a trailing dotted quad). */
function hextets(address: string): number[] | null {
  let addr = address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);

  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    addr = `${addr.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, tail] = addr.split("::");
  const parse = (s: string) => (s ? s.split(":").map((h) => Number.parseInt(h, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;

  if (fill < 0) return null;

  const out = [...left, ...new Array(fill).fill(0), ...right];
  return out.length === 8 && out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? out
    : null;
}

/** The IPv4 address embedded in an IPv6 address (mapped, compatible, NAT64, 6to4), if any. */
function embeddedV4(address: string): string | null {
  const h = hextets(address);

  if (!h) return null;

  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible)
  if (h.slice(0, 5).every((n) => n === 0) && (h[5] === 0xffff || h[5] === 0)) {
    return h[6] === 0 && h[7] <= 1 && h[5] === 0 ? null : v4(h[6], h[7]);
  }

  // 64:ff9b::a.b.c.d (NAT64 well-known prefix)
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((n) => n === 0)) {
    return v4(h[6], h[7]);
  }

  // 2002:wwxx:yyzz::/48 (6to4)
  if (h[0] === 0x2002) {
    return v4(h[1], h[2]);
  }

  return null;
}

export function isBlockedIp(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "");
  const family = isIP(ip);

  if (family === 4) {
    return blocked.check(ip, "ipv4");
  }

  if (family === 6) {
    const v4 = embeddedV4(ip);

    if (v4 && blocked.check(v4, "ipv4")) {
      return true;
    }

    return blocked.check(ip, "ipv6");
  }

  return false; // not an IP literal
}

export class BlockedTargetError extends Error {
  readonly code = "BLOCKED_TARGET";

  constructor(detail: string) {
    super(`Blocked target: ${detail}`);
  }
}

export const ALLOWED_PORTS = new Set(["", "80", "443"]);

/** Checks that do not need DNS: scheme, port, credentials, IP-literal hosts. */
export function assertSafeUrl(raw: string, allowPrivate = false): URL {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError(`invalid URL ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedTargetError(`scheme ${url.protocol}`);
  }

  if (url.username || url.password) {
    throw new BlockedTargetError("credentials in URL");
  }

  if (!allowPrivate && !ALLOWED_PORTS.has(url.port)) {
    throw new BlockedTargetError(`port ${url.port}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost") || isBlockedIp(host))) {
    throw new BlockedTargetError(`address ${host}`);
  }

  return url;
}
