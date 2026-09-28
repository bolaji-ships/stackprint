// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A drop-in `lookup` for net/tls/undici that refuses private addresses.
 *
 * The check happens on the addresses actually used to connect, which closes the DNS-rebinding gap of
 * "resolve, check, then connect". If any resolved address is private, the whole name is refused.
 * Supports `{ all: true }`, which Node's dual-stack connection logic (autoSelectFamily) uses.
 */

import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { BlockedTargetError, isBlockedIp } from "./ip-guard.js";

export type Resolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const systemResolver: Resolver = (hostname, options, callback) =>
  dnsLookup(hostname, options, callback);

export function createSafeLookup(
  options: { allowPrivate?: boolean; resolver?: Resolver } = {},
): LookupFunction {
  const resolver = options.resolver ?? systemResolver;

  return ((hostname: string, opts: unknown, callback: unknown) => {
    const cb = (typeof opts === "function" ? opts : callback) as (
      err: NodeJS.ErrnoException | null,
      address?: string | LookupAddress[],
      family?: number,
    ) => void;
    const o = (typeof opts === "object" && opts !== null ? opts : {}) as {
      all?: boolean;
      family?: number;
      hints?: number;
    };

    resolver(hostname, { ...o, all: true } as LookupAllOptions, (err, addresses) => {
      if (err) {
        cb(err);
        return;
      }

      const list = addresses ?? [];

      if (!options.allowPrivate) {
        const bad = list.find((a) => isBlockedIp(a.address));

        if (bad) {
          const error = new BlockedTargetError(
            `${hostname} resolves to ${bad.address}`,
          ) as Error & {
            code: string;
          };
          cb(error as unknown as NodeJS.ErrnoException);
          return;
        }
      }

      if (!list.length) {
        const error = Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
        cb(error);
        return;
      }

      if (o.all) {
        cb(null, list);
      } else {
        cb(null, list[0].address, list[0].family);
      }
    });
  }) as LookupFunction;
}
