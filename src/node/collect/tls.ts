// SPDX-License-Identifier: AGPL-3.0-or-later
/** Certificate issuer and expiry from a TLS handshake (no HTTP request). */

import { connect } from "node:tls";
import { isBlockedIp } from "../net/ip-guard.js";
import { createSafeLookup, type Resolver } from "../net/safe-lookup.js";

export interface TlsCapture {
  issuer: string | null;
  validTo: string | null;
  daysToExpiry: number | null;
  valid: boolean;
  error: string | null;
}

export function collectTls(
  host: string,
  options: { timeoutMs?: number; allowPrivate?: boolean; resolver?: Resolver; port?: number } = {},
): Promise<TlsCapture | null> {
  if (!options.allowPrivate && isBlockedIp(host)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: TlsCapture | null) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(value);
      }
    };

    const socket = connect({
      host,
      port: options.port ?? 443,
      servername: /^[\d.:]+$/.test(host) ? undefined : host,
      rejectUnauthorized: false,
      lookup: createSafeLookup({ allowPrivate: options.allowPrivate, resolver: options.resolver }),
      timeout: options.timeoutMs ?? 5_000,
    });

    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();

      if (!cert || !Object.keys(cert).length) {
        finish(null);
        return;
      }

      const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
      const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

      finish({
        issuer: pick(cert.issuer?.O) ?? pick(cert.issuer?.CN) ?? null,
        validTo: validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString() : null,
        daysToExpiry:
          validTo && !Number.isNaN(validTo.getTime())
            ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
            : null,
        valid: socket.authorized,
        error: socket.authorized ? null : String(socket.authorizationError ?? "invalid"),
      });
    });

    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));
  });
}
