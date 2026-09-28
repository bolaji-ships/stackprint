// SPDX-License-Identifier: AGPL-3.0-or-later
/** DNS records for fingerprints and email/hosting classification. */

import { Resolver } from "node:dns/promises";
import type { DnsType } from "../../core/types.js";
import { isBlockedIp } from "../net/ip-guard.js";

export interface DnsCapture {
  mx: { exchange: string; priority: number }[];
  txt: string[];
  ns: string[];
  soa: string | null;
  /** CNAME chain of the scanned host (e.g. www.acme.com -> shops.myshopify.com). */
  cname: string[];
  a: string[];
  ptr: string[];
  dmarc: string | null;
  autodiscover: string | null;
  errors: Record<string, string>;
}

export interface DnsOptions {
  servers?: string[];
  timeoutMs?: number;
}

const NOT_AN_ERROR = new Set(["ENODATA", "ENOTFOUND", "NOTFOUND", "ENOTIMP"]);

/**
 * Public resolvers by default: local ISP resolvers were measured stalling ~3 s on some queries, while
 * 1.1.1.1 / 8.8.8.8 answered each in ~110 ms. Override with DNS_SERVERS=ip,ip (or "system").
 */
const DEFAULT_SERVERS = ["1.1.1.1", "8.8.8.8"];

function makeResolver(options: DnsOptions): Resolver {
  const resolver = new Resolver({ timeout: options.timeoutMs ?? 1_500, tries: 2 });
  const env = process.env.DNS_SERVERS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const servers = options.servers ?? (env?.[0] === "system" ? null : (env ?? DEFAULT_SERVERS));

  if (servers?.length) {
    resolver.setServers(servers);
  }

  return resolver;
}

export async function collectDns(
  target: { host: string; registrable: string | null; domainDns: boolean },
  options: DnsOptions = {},
): Promise<DnsCapture> {
  const r = makeResolver(options);
  const errors: Record<string, string> = {};
  const apex = target.registrable;
  const clean = (h: string) => h.toLowerCase().replace(/\.$/, "");

  const run = async <T>(name: string, fn: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      const code = (error as { code?: string }).code ?? String(error);

      if (!NOT_AN_ERROR.has(code)) {
        errors[name] = code;
      }

      return empty;
    }
  };

  const domain = target.domainDns && apex;

  const [mx, txt, ns, soa, dmarc, autodiscover, cname, a] = await Promise.all([
    domain ? run("mx", () => r.resolveMx(apex), []) : Promise.resolve([]),
    domain ? run("txt", () => r.resolveTxt(apex), [] as string[][]) : Promise.resolve([]),
    domain ? run("ns", () => r.resolveNs(apex), [] as string[]) : Promise.resolve([]),
    domain ? run("soa", () => r.resolveSoa(apex), null) : Promise.resolve(null),
    domain
      ? run("dmarc", () => r.resolveTxt(`_dmarc.${apex}`), [] as string[][])
      : Promise.resolve([]),
    domain
      ? run("autodiscover", () => r.resolveCname(`autodiscover.${apex}`), [] as string[])
      : Promise.resolve([]),
    run("cname", () => r.resolveCname(target.host), [] as string[]),
    run("a", () => r.resolve4(target.host), [] as string[]),
  ]);

  const publicA = a.filter((ip) => !isBlockedIp(ip));
  const ptr = publicA.length ? await run("ptr", () => r.reverse(publicA[0]), [] as string[]) : [];

  return {
    mx: mx.map((m) => ({ exchange: clean(m.exchange), priority: m.priority })),
    txt: txt.map((chunks) => chunks.join("")),
    ns: ns.map(clean),
    soa: soa ? `${clean(soa.nsname)} ${clean(soa.hostmaster)}` : null,
    cname: cname.map(clean),
    a,
    ptr: ptr.map(clean),
    dmarc: dmarc.map((c) => c.join("")).find((t) => /^v=dmarc1/i.test(t)) ?? null,
    autodiscover: autodiscover[0] ? clean(autodiscover[0]) : null,
    errors,
  };
}

/** DNS in the shape the fingerprints expect (lowercase record types). */
export function dnsSignals(dns: DnsCapture): Partial<Record<DnsType, string[]>> {
  return {
    mx: dns.mx.map((m) => m.exchange),
    txt: dns.txt,
    ns: dns.ns,
    soa: dns.soa ? [dns.soa] : [],
    cname: dns.cname,
  };
}
