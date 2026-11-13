/** Shared helpers for the approvals commands: usage errors, whole-number flags and JSON object flags. */

import { KError } from "@k9o/core";
import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import { emitError, type OutputFormat } from "../output.ts";
import { EXIT_USAGE } from "../exit-codes.ts";

export function usageError(format: OutputFormat, message: string, recommendation?: string): number {
  emitError(format, new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message,
    context: {},
    ...(recommendation !== undefined ? { recommendation } : {}),
  }));
  return EXIT_USAGE;
}

/** A whole-number flag in [min, max]: undefined when absent, an error message string when invalid. */
export function intFlag(args: ParsedArgs, name: string, min: number, max: number): number | undefined | string {
  const raw = args.flags[name];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) return `--${name} must be a whole number from ${min} to ${max}`;
  return Number(raw);
}

/** A flag holding a JSON object: the parsed object, undefined when absent, or an error message string. */
export function jsonObjectFlag(args: ParsedArgs, name: string): Record<string, unknown> | undefined | string {
  const raw = args.flags[name];
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `--${name} must be a JSON object`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return `--${name} must be a JSON object`;
  return parsed as Record<string, unknown>;
}

/** A string flag that must carry a value (a bare `--name` parses as "true"). */
export function textFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return v === undefined || v === "true" ? undefined : v;
}

/**
 * A flag holding JSON of any shape: inline, `@file`, or `-` for stdin. Returns the parsed value, undefined when the
 * flag is absent, or an error message string.
 */
export function jsonSourceFlag(args: ParsedArgs, name: string): { value: unknown } | undefined | string {
  const raw = args.flags[name];
  if (raw === undefined) return undefined;
  if (raw === "true") return `--${name} needs a value`;
  let text = raw;
  if (raw === "-" || raw.startsWith("@")) {
    try {
      text = readFileSync(raw === "-" ? 0 : raw.slice(1), "utf8");
    } catch (e) {
      return `Failed to read --${name} from ${raw === "-" ? "stdin" : raw.slice(1)}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return `--${name} is not valid JSON`;
  }
}

/** A switch pair such as `--log-ok-invocations` / `--no-log-ok-invocations`: true, false, undefined when neither, or an error message when both. */
export function switchPair(args: ParsedArgs, on: string, off: string): boolean | undefined | string {
  const a = args.flags[on] === "true";
  const b = args.flags[off] === "true";
  if (a && b) return `use only one of --${on} and --${off}`;
  return a ? true : b ? false : undefined;
}

/** A comma-separated flag as a list, undefined when absent, or an error message when it carries no value. */
export function listFlag(args: ParsedArgs, name: string): string[] | undefined | string {
  const raw = args.flags[name];
  if (raw === undefined) return undefined;
  if (raw === "true") return `--${name} needs a value`;
  return raw.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
}

/** JSON from `--inline` or, when absent, from `--file` (a path, or `-` for stdin). Undefined when neither is given; a string is an error message. */
export function jsonInput(args: ParsedArgs, inline: string, file: string): { value: unknown } | undefined | string {
  const raw = args.flags[inline];
  const path = args.flags[file];
  if (raw !== undefined && path !== undefined) return `use only one of --${inline} and --${file}`;
  if (raw === undefined && path === undefined) return undefined;
  let text: string;
  if (raw !== undefined) {
    if (raw === "true") return `--${inline} needs a value`;
    text = raw;
  } else {
    if (path === "true") return `--${file} needs a path, or - for stdin`;
    try {
      text = readFileSync(path === "-" ? 0 : path!, "utf8");
    } catch (e) {
      return `Failed to read --${file} from ${path === "-" ? "stdin" : path}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return `--${raw !== undefined ? inline : file} is not valid JSON`;
  }
}

/** A string flag's value, undefined when absent, or `{ error }` when given bare (`--name` with no value). */
export function valueFlag(args: ParsedArgs, name: string): string | undefined | { error: string } {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (v === "true") return { error: `--${name} needs a value` };
  return v;
}

/** Positional argument `index` (0 is the command group), or a usage error message. */
export function positionalArg(args: ParsedArgs, index: number): string | undefined {
  const v = args.positional[index];
  return v === undefined || v.length === 0 ? undefined : v;
}
