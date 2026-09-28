// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Email setup from DNS: mailbox provider, security gateway, sending tools, DMARC.
 *
 * A gateway (Proofpoint, Mimecast...) hides the provider behind it in MX, so the provider is inferred
 * from SPF includes, the Microsoft tenant token (MS=) and the autodiscover CNAME. google-site-verification
 * is never used as Workspace evidence: it comes from Search Console.
 */

import { type CoreData, suffixLookup } from "../data.js";

export interface DnsSnapshot {
  mx: { exchange: string; priority: number }[];
  txt: string[];
  /** CNAME target of autodiscover.<domain>, if any. */
  autodiscover: string | null;
  /** The _dmarc TXT record, if any. */
  dmarc: string | null;
}

export interface EmailInfo {
  provider: string | null;
  /** How the provider was determined. */
  providerSource: "mx" | "spf" | "ms-token" | "autodiscover" | "own-server" | null;
  gateway: string | null;
  senders: string[];
  spfIncludes: string[];
  dmarcPolicy: string | null;
  dmarcVendor: string | null;
  verifications: string[];
}

function clean(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function spfIncludes(txt: string[]): string[] {
  const spf = txt.find((t) => /^v=spf1\b/i.test(t.trim()));

  if (!spf) {
    return [];
  }

  const out: string[] = [];

  for (const m of spf.matchAll(/\b(?:include:|redirect=)([^\s]+)/gi)) {
    const host = clean(m[1]);
    if (!out.includes(host)) out.push(host);
  }

  return out;
}

export function verificationTokens(txt: string[]): string[] {
  const out = new Set<string>();

  for (const record of txt) {
    const t = record.trim();

    if (/^v=spf1\b/i.test(t) || /^v=dmarc1\b/i.test(t)) continue;

    const m = /^([a-z0-9][a-z0-9_.-]{1,60}?)(?:=|:)/i.exec(t);

    if (m && (/verif|validation|confirm|domain-/i.test(m[1]) || /^ms$/i.test(m[1]))) {
      out.add(m[1].toLowerCase());
    }
  }

  return [...out].slice(0, 20);
}

export function classifyEmail(dns: DnsSnapshot, data: CoreData, ownDomain: string): EmailInfo {
  const mx = [...dns.mx]
    .sort((a, b) => a.priority - b.priority)
    .map((r) => clean(r.exchange))
    .filter(Boolean);

  const gateway =
    mx.map((h) => data.gateways.find(([, re]) => re.test(h))?.[0]).find(Boolean) ?? null;

  let provider =
    mx.map((h) => data.providers.find(([, re]) => re.test(h))?.[0]).find(Boolean) ?? null;
  let providerSource: EmailInfo["providerSource"] = provider ? "mx" : null;

  const includes = spfIncludes(dns.txt);

  if (!provider) {
    const fromSpf = includes.map((h) => suffixLookup(h, data.spfProviders)).find(Boolean);

    if (fromSpf) {
      provider = fromSpf;
      providerSource = "spf";
    } else if (
      // A Microsoft tenant token only proves the domain was verified with Microsoft (Teams, Entra...),
      // so it only names the provider when a gateway is hiding the real MX.
      gateway &&
      dns.txt.some((t) => /^MS=(?:ms[\w-]+|[0-9A-Fa-f]{40})$/.test(t.trim()))
    ) {
      provider = "Microsoft 365";
      providerSource = "ms-token";
    } else if (dns.autodiscover && /autodiscover\.outlook\.com$/i.test(clean(dns.autodiscover))) {
      provider = "Microsoft 365";
      providerSource = "autodiscover";
    } else if (mx.length && mx.every((h) => h === ownDomain || h.endsWith(`.${ownDomain}`))) {
      provider = "Own mail server";
      providerSource = "own-server";
    }
  }

  const providerIncludes = new Set(
    includes.filter((h) => suffixLookup(h, data.spfProviders) !== null),
  );
  const senders: string[] = [];

  for (const host of includes) {
    if (providerIncludes.has(host)) continue;

    const sender = suffixLookup(host, data.spfSenders);

    if (sender && !senders.includes(sender)) {
      senders.push(sender);
    }
  }

  let dmarcPolicy: string | null = null;
  let dmarcVendor: string | null = null;

  if (dns.dmarc && /^v=dmarc1\b/i.test(dns.dmarc.trim())) {
    // "p=none" rather than "none": a bare "none" reads as a placeholder to campaign-qa.
    const policy = /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\b/i
      .exec(dns.dmarc)?.[1]
      ?.toLowerCase();
    dmarcPolicy = policy ? `p=${policy}` : null;

    for (const m of dns.dmarc.matchAll(/mailto:[^@\s;,]+@([a-z0-9.-]+)/gi)) {
      dmarcVendor = suffixLookup(m[1], data.dmarcVendors);
      if (dmarcVendor) break;
    }
  }

  return {
    provider,
    providerSource,
    gateway,
    senders,
    spfIncludes: includes,
    dmarcPolicy,
    dmarcVendor,
    verifications: verificationTokens(dns.txt),
  };
}
