// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Benchmark against a local Prospeo company cache (their technology lists use upstream Wappalyzer names).
 *
 *   npx tsx bench/prospeo.ts --raw <dir> --out <private dir> [--n 400] [--deep 150] [--seed 42]
 *
 * Writes results.jsonl and report.md to --out. Never commit either: they contain third-party data.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ScanResult } from "../src/core/result.js";
import { displayName } from "../src/core/summary/summarize.js";
import { browserPool } from "../src/node/collect/browser.js";
import { FINGERPRINTS_DIR } from "../src/node/fingerprints.js";
import { closeAgents } from "../src/node/net/http.js";
import { getRuntime } from "../src/node/runtime.js";
import { Service } from "../src/node/service.js";
import { type ProspeoCompany, readProspeo, shuffle } from "./prospeo-data.js";

const { values } = parseArgs({
  options: {
    raw: { type: "string" },
    out: { type: "string" },
    n: { type: "string", default: "400" },
    deep: { type: "string", default: "150" },
    seed: { type: "string", default: "42" },
    concurrency: { type: "string", default: "8" },
  },
});

if (!values.raw || !values.out) throw new Error("--raw and --out are required");

const runtime = getRuntime();
const { data, engine } = runtime;
const readOverlay = (f: string) =>
  JSON.parse(readFileSync(`${FINGERPRINTS_DIR}overlay/${f}`, "utf8"));
const renames: Record<string, string> = {
  ...readOverlay("duplicates.json"),
  ...readOverlay("aliases.json"),
};
const canonical = (name: string) => renames[name] ?? name;

// ---- sample -------------------------------------------------------------------------------------

const STRATA: [string, (names: Set<string>) => boolean][] = [
  ["hubspot-cms", (n) => n.has("HubSpot CMS Hub")],
  ["webflow", (n) => n.has("Webflow")],
  ["wix", (n) => n.has("Wix")],
  ["squarespace", (n) => n.has("Squarespace")],
  ["wordpress", (n) => n.has("WordPress")],
  ["nextjs-vercel", (n) => n.has("Next.js") || n.has("Vercel")],
  ["other", () => true],
];

const companies = readProspeo(values.raw).filter((c) => c.technologies.length > 0);
const byStratum = new Map<string, ProspeoCompany[]>();

for (const c of shuffle(companies, Number(values.seed))) {
  const names = new Set(c.technologies.map((t) => canonical(t.name)));
  const stratum = STRATA.find(([, test]) => test(names))![0];
  byStratum.set(stratum, [...(byStratum.get(stratum) ?? []), c]);
}

const total = Number(values.n);
const per = Math.floor(total / STRATA.length);
const sample: (ProspeoCompany & { stratum: string })[] = [];

for (const [stratum] of STRATA) {
  for (const c of (byStratum.get(stratum) ?? []).slice(0, per)) sample.push({ ...c, stratum });
}

for (const c of (byStratum.get("other") ?? []).slice(per, per + (total - sample.length))) {
  sample.push({ ...c, stratum: "other" });
}

console.error(`sample ${sample.length} of ${companies.length} companies with tech lists`);

// ---- scan ---------------------------------------------------------------------------------------

mkdirSync(values.out, { recursive: true });
const service = new Service(runtime, null, { maxConcurrent: Number(values.concurrency) });

async function runAll(list: typeof sample, mode: "fast" | "deep", concurrency: number) {
  const results: { company: (typeof sample)[number]; result: ScanResult; ms: number }[] = [];
  let next = 0;

  const worker = async () => {
    while (next < list.length) {
      const company = list[next];
      next += 1;
      const t0 = performance.now();
      const result = await service.lookup(company.website, { mode, fresh: true, view: "full" });
      const ms = performance.now() - t0;
      results.push({ company, result, ms });
      process.stderr.write(
        `[${mode} ${results.length}/${list.length}] ${company.domain.padEnd(34)} ${result.scan_status} ${result.error_code ?? ""} ${(ms / 1000).toFixed(1)}s\n`,
      );
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

const fast = await runAll(sample, "fast", Number(values.concurrency));
const deepSubset = sample.slice(0, Number(values.deep));
const deep = deepSubset.length ? await runAll(deepSubset, "deep", 2) : [];
await browserPool.close();
await closeAgents();

writeFileSync(
  join(values.out, "results.jsonl"),
  [...fast, ...deep]
    .map(({ company, result, ms }) =>
      JSON.stringify({
        domain: company.domain,
        stratum: company.stratum,
        mode: result.mode,
        ms,
        prospeo: company.technologies.map((t) => t.name),
        mx: company.mxProvider,
        result,
      }),
    )
    .join("\n"),
);

// ---- metrics ------------------------------------------------------------------------------------

const watch = JSON.parse(readFileSync(new URL("./watchlist.json", import.meta.url), "utf8"))
  .technologies as {
  name: string;
  aliases?: string[];
}[];
const watchNames = new Map<string, string>();
for (const w of watch) for (const n of [w.name, ...(w.aliases ?? [])]) watchNames.set(n, w.name);

const ours = (r: ScanResult) =>
  new Set((r.technologies ?? []).filter((t) => t.confidence >= 50).map((t) => canonical(t.name)));
/** Prospeo's tech lists come from a page crawl: they carry no TLS, nameserver or TXT-token data. */
const onPage = (r: ScanResult) =>
  new Set(
    (r.technologies ?? [])
      .filter(
        (t) =>
          t.confidence >= 50 &&
          t.fields.some(
            (f) => !f.startsWith("dns") && f !== "certIssuer" && f !== "ptr" && f !== "implies",
          ),
      )
      .map((t) => canonical(t.name)),
  );
const theirs = (c: ProspeoCompany) => new Set(c.technologies.map((t) => canonical(t.name)));

type Counts = { tp: number; fp: number; fn: number };
const tally = (rows: typeof fast, filter: (name: string) => boolean, pick = ours) => {
  const per = new Map<string, Counts>();
  const all: Counts = { tp: 0, fp: 0, fn: 0 };
  const bump = (name: string, k: keyof Counts) => {
    const c = per.get(name) ?? { tp: 0, fp: 0, fn: 0 };
    c[k] += 1;
    per.set(name, c);
    all[k] += 1;
  };

  for (const { company, result } of rows) {
    if (result.scan_status !== "ok") continue;

    const s = pick(result);
    const p = theirs(company);

    for (const n of s) if (filter(n)) bump(n, p.has(n) ? "tp" : "fp");
    for (const n of p) if (filter(n) && !s.has(n)) bump(n, "fn");
  }

  return { per, all };
};

const prf = (c: Counts) => {
  const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 0;
  const recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const isWatch = (n: string) => watchNames.has(n);
const notNoise = (n: string) => !data.noise.has(n);

const fastWatch = tally(fast, isWatch);
const fastAll = tally(fast, notNoise);
const fastWatchAdj = tally(fast, isWatch, onPage);
const fastAllAdj = tally(fast, notNoise, onPage);
const deepDomains = new Set(deep.map((d) => d.company.domain));
const fastOnDeepSubset = fast.filter((f) => deepDomains.has(f.company.domain));
const deepWatch = tally(deep, isWatch);
const fastWatchSubset = tally(fastOnDeepSubset, isWatch);

// Email agreement
const GATEWAY_LABELS: Record<string, string> = {
  Proofpoint: "Proofpoint",
  Mimecast: "Mimecast",
  Barracuda: "Barracuda Email Protection",
  "Cisco IronPort": "Cisco Secure Email",
  SpamExperts: "SpamExperts",
  ARSMTP: "Zix",
};
const PROVIDER_LABELS: Record<string, string> = {
  Google: "Google Workspace",
  Microsoft: "Microsoft 365",
  Zoho: "Zoho Mail",
  Rackspace: "Rackspace Email",
  IONOS: "IONOS Mail",
  Hostinger: "Hostinger Email",
  "AWS SES": "Amazon SES (inbound)",
  Serverdata: "Intermedia",
};
let emailCompared = 0;
let emailAgree = 0;
let gatewayTotal = 0;
let gatewayWithProvider = 0;
const emailMisses: string[] = [];

for (const { company, result } of fast) {
  if (!company.mxProvider || result.scan_status === "skipped") continue;

  const gateway = GATEWAY_LABELS[company.mxProvider];
  const provider = PROVIDER_LABELS[company.mxProvider];

  if (!gateway && !provider) continue;

  emailCompared += 1;
  const agree = gateway ? result.email_gateway === gateway : result.email_provider === provider;

  if (agree) emailAgree += 1;
  else if (emailMisses.length < 25)
    emailMisses.push(
      `${company.domain}: prospeo ${company.mxProvider}, ours ${result.email_provider ?? "-"} / gateway ${result.email_gateway ?? "-"}`,
    );

  if (gateway && result.email_gateway === gateway) {
    gatewayTotal += 1;
    if (result.email_provider) gatewayWithProvider += 1;
  }
}

// Layer contributions (true positives by evidence source)
const layers = new Map<string, number>();

for (const { company, result } of fast) {
  if (result.scan_status !== "ok") continue;
  const p = theirs(company);

  for (const t of result.technologies ?? []) {
    if (t.confidence < 50 || !p.has(canonical(t.name))) continue;
    const via = [...new Set(t.evidence.map((e) => e.via))].sort().join("+") || "?";
    layers.set(via, (layers.get(via) ?? 0) + 1);
  }
}

const statusMix = (rows: typeof fast) => {
  const m = new Map<string, number>();
  for (const { result } of rows) {
    const k = result.error_code ? `${result.scan_status}:${result.error_code}` : result.scan_status;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]);
};

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))] ?? 0;
};

const top = (per: Map<string, Counts>, key: "fp" | "fn", n = 15) =>
  [...per]
    .filter(([, c]) => c[key] > 0)
    .sort((a, b) => b[1][key] - a[1][key])
    .slice(0, n);

const samplesOf = (rows: typeof fast, kind: "fp" | "fn", limit = 25) => {
  const out: string[] = [];

  for (const { company, result } of shuffle(rows, 7)) {
    if (result.scan_status !== "ok") continue;
    const s = ours(result);
    const p = theirs(company);

    if (kind === "fp") {
      for (const t of result.technologies ?? []) {
        const n = canonical(t.name);
        if (t.confidence >= 50 && notNoise(n) && !p.has(n) && out.length < limit) {
          const e = t.evidence[0];
          out.push(
            `${company.domain}: ${n} (${e ? `${e.field}${e.key ? ` ${e.key}` : ""}: ${e.match} [${e.via}]` : "implied"})`,
          );
        }
      }
    } else {
      for (const n of p)
        if (notNoise(n) && isWatch(n) && !s.has(n) && out.length < limit)
          out.push(`${company.domain}: ${n}`);
    }
  }

  return out;
};

const lines: string[] = [];
const L = (s = "") => lines.push(s);

L(`# stackprint benchmark vs Prospeo (${new Date().toISOString().slice(0, 10)})`);
L();
L(
  `Fingerprints ${engine.version}. Sample ${sample.length} domains (seed ${values.seed}), stratified: ${STRATA.map(([s]) => `${s} ${sample.filter((c) => c.stratum === s).length}`).join(", ")}. Deep subset ${deep.length}.`,
);
L();
L(
  "Prospeo's crawl date is unknown and it appears to use a browser, so disagreement mixes our errors with stale or deep-only data. Adjudicate before quoting numbers.",
);
L();
L("## Headline (fast mode, ok scans)");
L();
L("| Measure | Value |");
L("|---|---|");
const w = prf(fastWatch.all);
const a = prf(fastAll.all);
L(
  `| Watchlist precision / recall / F1 | ${pct(w.precision)} / ${pct(w.recall)} / ${pct(w.f1)} (TP ${fastWatch.all.tp}, FP ${fastWatch.all.fp}, FN ${fastWatch.all.fn}) |`,
);
L(
  `| All non-noise precision / recall / F1 | ${pct(a.precision)} / ${pct(a.recall)} / ${pct(a.f1)} (TP ${fastAll.all.tp}, FP ${fastAll.all.fp}, FN ${fastAll.all.fn}) |`,
);
const wa = prf(fastWatchAdj.all);
const aa = prf(fastAllAdj.all);
L(
  `| Adjusted (on-page evidence only) watchlist P / R / F1 | ${pct(wa.precision)} / ${pct(wa.recall)} / ${pct(wa.f1)} |`,
);
L(
  `| Adjusted all non-noise P / R / F1 | ${pct(aa.precision)} / ${pct(aa.recall)} / ${pct(aa.f1)} |`,
);
L(
  `| Email agreement (MX provider or gateway) | ${pct(emailCompared ? emailAgree / emailCompared : 0)} of ${emailCompared} |`,
);
L(
  `| Gateway domains where we also named the provider underneath | ${gatewayTotal ? pct(gatewayWithProvider / gatewayTotal) : "n/a"} of ${gatewayTotal} |`,
);
L(
  `| Latency p50 / p95 (fast) | ${(
    quantile(
      fast.map((f) => f.ms),
      0.5,
    ) / 1000
  ).toFixed(1)} s / ${(
    quantile(
      fast.map((f) => f.ms),
      0.95,
    ) / 1000
  ).toFixed(1)} s |`,
);
if (deep.length) {
  L(
    `| Latency p50 / p95 (deep) | ${(
      quantile(
        deep.map((f) => f.ms),
        0.5,
      ) / 1000
    ).toFixed(1)} s / ${(
      quantile(
        deep.map((f) => f.ms),
        0.95,
      ) / 1000
    ).toFixed(1)} s |`,
  );
  const dw = prf(deepWatch.all);
  const fw = prf(fastWatchSubset.all);
  L(
    `| Watchlist recall on the deep subset: fast vs deep | ${pct(fw.recall)} vs ${pct(dw.recall)} (${((dw.recall - fw.recall) * 100).toFixed(1)} points); precision ${pct(fw.precision)} vs ${pct(dw.precision)} |`,
  );
}
L();
L("## Scan outcomes");
L();
L(
  `Fast: ${statusMix(fast)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")}`,
);
if (deep.length)
  L(
    `Deep: ${statusMix(deep)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
L();
L("## Where true positives come from (fast)");
L();
for (const [via, n] of [...layers].sort((x, y) => y[1] - x[1])) L(`- ${via}: ${n}`);
L();
L("## Watchlist technologies (support 5+)");
L();
L("| Technology | Precision | Recall | TP | FP | FN |");
L("|---|---|---|---|---|---|");
for (const [name, c] of [...fastWatch.per].sort(
  (x, y) => y[1].tp + y[1].fn - (x[1].tp + x[1].fn),
)) {
  if (c.tp + c.fn + c.fp < 5) continue;
  const m = prf(c);
  L(
    `| ${displayName(name, data)} | ${pct(m.precision)} | ${pct(m.recall)} | ${c.tp} | ${c.fp} | ${c.fn} |`,
  );
}
L();
L("## Biggest disagreements (all non-noise)");
L();
L(
  `Most "we found, Prospeo did not": ${top(fastAll.per, "fp")
    .map(([n, c]) => `${n} ${c.fp}`)
    .join(", ")}`,
);
L();
L(
  `Most "Prospeo found, we did not": ${top(fastAll.per, "fn")
    .map(([n, c]) => `${n} ${c.fn}`)
    .join(", ")}`,
);
L();
L("## Adjudication samples");
L();
L("False positives (25):");
for (const s of samplesOf(fast, "fp")) L(`- ${s}`);
L();
L("False negatives on watchlist (25):");
for (const s of samplesOf(fast, "fn")) L(`- ${s}`);
L();
L("Email disagreements:");
for (const s of emailMisses) L(`- ${s}`);

writeFileSync(join(values.out, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.slice(0, 30).join("\n"));
console.error(`\nWrote ${join(values.out, "report.md")}`);
