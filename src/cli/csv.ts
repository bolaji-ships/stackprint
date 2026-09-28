// SPDX-License-Identifier: AGPL-3.0-or-later
/** CSV conventions: null -> empty cell, booleans -> yes / no. */

import { stringify } from "csv-stringify/sync";
import { FLAT_FIELDS, type FlatSummary } from "../core/result.js";

export function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** Output column name for a flat field, avoiding collisions with the input file's own columns. */
export function outputColumns(
  inputColumns: string[],
): Record<(typeof FLAT_FIELDS)[number], string> {
  const taken = new Set(inputColumns);
  return Object.fromEntries(
    FLAT_FIELDS.map((f) => [f, taken.has(f) ? `stackprint_${f}` : f]),
  ) as Record<(typeof FLAT_FIELDS)[number], string>;
}

export function flatRow(
  summary: FlatSummary,
  names: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(FLAT_FIELDS.map((f) => [names[f], cell(summary[f])]));
}

export function toCsv(rows: Record<string, string>[], columns: string[]): string {
  return stringify(rows, { header: true, columns });
}
