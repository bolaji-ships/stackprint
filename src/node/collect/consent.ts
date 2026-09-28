// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Accept a cookie banner once, so tags that wait for consent can load. Only known consent managers'
 * "accept all" buttons are clicked; nothing generic.
 */

import type { Page } from "playwright";

export interface ConsentResult {
  cmp: string | null;
  accepted: boolean;
}

const ACCEPT_BUTTONS: [string, string][] = [
  ["OneTrust", "#onetrust-accept-btn-handler"],
  ["Cookiebot", "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"],
  ["Cookiebot", "#CybotCookiebotDialogBodyButtonAccept"],
  ["CookieYes", "[data-cky-tag='accept-button']"],
  ["CookieYes", ".cky-btn-accept"],
  ["Didomi", "#didomi-notice-agree-button"],
  ["Usercentrics", "[data-testid='uc-accept-all-button']"],
  ["Complianz", ".cmplz-btn.cmplz-accept"],
  ["Termly", "[data-tid='banner-accept']"],
  ["Osano", ".osano-cm-accept-all"],
  ["HubSpot", "#hs-eu-confirmation-button"],
  ["Quantcast", ".qc-cmp2-summary-buttons button[mode='primary']"],
  ["TrustArc", "#truste-consent-button"],
  ["iubenda", ".iubenda-cs-accept-btn"],
  ["CookieScript", "#cookiescript_accept"],
  ["Klaro", ".klaro .cm-btn-accept-all"],
];

export async function acceptConsent(page: Page): Promise<ConsentResult> {
  for (const [cmp, selector] of ACCEPT_BUTTONS) {
    const button = page.locator(selector).first();

    try {
      if (await button.isVisible({ timeout: 150 })) {
        await button.click({ timeout: 1_500 });
        return { cmp, accepted: true };
      }
    } catch {
      // not present or not clickable: try the next one
    }
  }

  return { cmp: null, accepted: false };
}
