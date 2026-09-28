// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bot walls and parked pages. Both matter for honesty: a challenge page or a parking page must never be
 * reported as a real site with "no technologies".
 */

export interface BotWall {
  vendor:
    | "cloudflare"
    | "datadome"
    | "akamai"
    | "imperva"
    | "perimeterx"
    | "aws-waf"
    | "sucuri"
    | "vercel";
  reason: string;
}

export function detectBotWall(
  status: number,
  headers: Record<string, string[]>,
  body: string,
): BotWall | null {
  const header = (name: string) => (headers[name] ?? []).join(" ").toLowerCase();
  const b = body.slice(0, 30_000).toLowerCase();
  const blockedStatus = status === 403 || status === 429 || status === 503;

  if (header("cf-mitigated").includes("challenge")) {
    return { vendor: "cloudflare", reason: "cf-mitigated: challenge" };
  }

  if (
    blockedStatus &&
    (b.includes("<title>just a moment...</title>") ||
      b.includes("challenges.cloudflare.com") ||
      b.includes("/cdn-cgi/challenge-platform/") ||
      b.includes("attention required! | cloudflare"))
  ) {
    return { vendor: "cloudflare", reason: "challenge page" };
  }

  if (
    header("x-vercel-mitigated").includes("challenge") ||
    b.includes("vercel security checkpoint")
  ) {
    return { vendor: "vercel", reason: "security checkpoint" };
  }

  if (/challenge|captcha/.test(header("x-amzn-waf-action"))) {
    return { vendor: "aws-waf", reason: "x-amzn-waf-action" };
  }

  if (
    (blockedStatus && (headers["x-datadome"] || headers["x-dd-b"])) ||
    b.includes("captcha-delivery.com")
  ) {
    return { vendor: "datadome", reason: blockedStatus ? `HTTP ${status}` : "captcha page" };
  }

  if (
    status === 403 &&
    b.includes("access denied") &&
    (b.includes("reference #") ||
      b.includes("errors.edgesuite.net") ||
      header("server").includes("akamaighost"))
  ) {
    return { vendor: "akamai", reason: "access denied" };
  }

  if (
    (b.includes("_incapsula_resource") || b.includes("incapsula incident id")) &&
    body.length < 20_000
  ) {
    return { vendor: "imperva", reason: "incapsula challenge" };
  }

  if (
    blockedStatus &&
    (b.includes("px-captcha") || b.includes("_pxappid") || b.includes("perimeterx"))
  ) {
    return { vendor: "perimeterx", reason: "captcha" };
  }

  if (b.includes("sucuri website firewall") && b.includes("access denied")) {
    return { vendor: "sucuri", reason: "firewall block" };
  }

  return null;
}

export interface Parking {
  reason: "registrar_parking" | "for_sale" | "hosting_default" | "under_construction" | "suspended";
  marker: string;
}

const PARKING_HTML: [Parking["reason"], string][] = [
  ["registrar_parking", "img1.wsimg.com/parking-lander"],
  ["registrar_parking", "parkingcrew.net"],
  ["registrar_parking", "sedoparking.com"],
  ["registrar_parking", "bodis.com"],
  ["registrar_parking", "parklogic.com"],
  ["registrar_parking", "parkingpage.namecheap.com"],
  ["registrar_parking", "dns-parking.com"],
  ["registrar_parking", "above.com/marketing"],
  ["for_sale", "afternic.com"],
  ["for_sale", "hugedomains.com"],
  ["for_sale", "dan.com/buy-domain"],
];

const PARKING_TEXT: [Parking["reason"], RegExp][] = [
  ["for_sale", /\b(this|the) domain (name )?(is|may be) for sale\b/],
  ["for_sale", /\bbuy this domain\b/],
  ["for_sale", /\bmake an offer on this domain\b/],
  ["registrar_parking", /\bthis domain (is|has been) registered (at|with|by)\b/],
  ["registrar_parking", /\bparked (free|domain)\b/],
  ["hosting_default", /\bfuture home of something quite cool\b/],
  ["hosting_default", /\bapache2 (ubuntu|debian) default page\b/],
  ["hosting_default", /\bwelcome to nginx!/],
  ["hosting_default", /\bdomain default page\b/],
  ["hosting_default", /\bweb server'?s default page\b/],
  ["hosting_default", /\bthis is the default (web )?page for this (server|domain)\b/],
  ["hosting_default", /^index of \//],
  ["suspended", /\b(this )?account (has been|is) suspended\b/],
  [
    "under_construction",
    /\b(website|site|page) (is )?(under construction|coming soon|launching soon)\b/,
  ],
  ["under_construction", /^(coming soon|under construction|launching soon)\b/],
];

/** Parking pages are small; real sites that happen to mention these phrases are not. */
const PARKING_TEXT_LIMIT = 2_500;

export function detectParking(html: string, text: string): Parking | null {
  if (text.length > PARKING_TEXT_LIMIT) {
    return null;
  }

  const lowHtml = html.slice(0, 200_000).toLowerCase();
  const lowText = text.toLowerCase();

  for (const [reason, marker] of PARKING_HTML) {
    if (lowHtml.includes(marker)) {
      return { reason, marker };
    }
  }

  for (const [reason, re] of PARKING_TEXT) {
    if (re.test(lowText)) {
      return { reason, marker: re.source };
    }
  }

  return null;
}
