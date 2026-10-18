// Runtime validators for every Busyholm contract, built from the JSON Schemas in
// contracts/schemas (the source of truth). Consumers validate whole messages
// atomically: on failure they drop the message and keep their last good state.
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import type { DataValidationCxt } from "ajv/dist/types/index.js";
import type { ContractKey, ContractTypes } from "./types.ts";

import agentEvent from "../../schemas/agent-event.v1.schema.json" with { type: "json" };
import snapshot from "../../schemas/snapshot.v2.schema.json" with { type: "json" };
import moment from "../../schemas/moment.v1.schema.json" with { type: "json" };
import ledger from "../../schemas/ledger.v1.schema.json" with { type: "json" };
import choices from "../../schemas/choices.v1.schema.json" with { type: "json" };
import world from "../../schemas/world.v1.schema.json" with { type: "json" };
import hitRects from "../../schemas/hit-rects.v1.schema.json" with { type: "json" };
import settings from "../../schemas/settings.v1.schema.json" with { type: "json" };
import installManifest from "../../schemas/install-manifest.v1.schema.json" with { type: "json" };
import pendingAlerts from "../../schemas/pending-alerts.v1.schema.json" with { type: "json" };

/** The parsed schema of every contract, keyed like CONTRACTS in types.ts. */
export const SCHEMAS: Readonly<Record<ContractKey, object>> = {
  agentEvent,
  snapshot,
  moment,
  ledger,
  choices,
  world,
  hitRects,
  settings,
  installManifest,
  pendingAlerts,
};

export interface ValidationIssue {
  /** JSON Pointer to the offending value ("" is the root). */
  path: string;
  /** The schema keyword that failed, for example "required" or "x-unique-by". */
  keyword: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

export class ContractError extends Error {
  readonly contract: ContractKey;
  readonly issues: ValidationIssue[];
  constructor(contract: ContractKey, issues: ValidationIssue[]) {
    const first = issues[0];
    super(`${contract}: invalid${first ? ` at "${first.path}": ${first.message}` : ""}`);
    this.name = "ContractError";
    this.contract = contract;
    this.issues = issues;
  }
}

type UniqueBy = string[][];

/**
 * x-unique-by: each listed tuple of item keys must be unique across the array.
 * Items that are not objects are left to the items schema to reject.
 */
function uniqueBy(this: unknown, schema: UniqueBy, data: unknown, _parent?: unknown, cxt?: DataValidationCxt): boolean {
  const self = uniqueBy as typeof uniqueBy & { errors?: Partial<ErrorObject>[] };
  const errors: Partial<ErrorObject>[] = [];
  if (Array.isArray(data)) {
    for (const keys of schema) {
      const seen = new Map<string, number>();
      data.forEach((item: unknown, index: number) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return;
        const record = item as Record<string, unknown>;
        const key = JSON.stringify(keys.map((k) => (k in record ? record[k] : null)));
        const first = seen.get(key);
        if (first === undefined) {
          seen.set(key, index);
        } else {
          errors.push({
            keyword: "x-unique-by",
            instancePath: `${cxt?.instancePath ?? ""}/${index}`,
            params: { keys, duplicateOf: first },
            message: `duplicate ${keys.join(" + ")} (same as item ${first})`,
          });
        }
      });
    }
  }
  self.errors = errors;
  return errors.length === 0;
}

function makeAjv(): InstanceType<typeof Ajv2020.default> {
  const ajv = new Ajv2020.default({
    strict: true,
    // These two lints cannot see a parent's properties and type from inside
    // if/then, and would force redundant declarations (contracts/CHANGES.md).
    strictRequired: false,
    strictTypes: false,
    allErrors: true,
  });
  ajv.addKeyword({
    keyword: "x-unique-by",
    type: "array",
    schemaType: "array",
    errors: true,
    metaSchema: {
      type: "array",
      minItems: 1,
      items: { type: "array", minItems: 1, items: { type: "string" } },
    },
    validate: uniqueBy,
  });
  return ajv;
}

const ajv = makeAjv();
const compiled = new Map<ContractKey, ValidateFunction>();

function validatorFor(key: ContractKey): ValidateFunction {
  let fn = compiled.get(key);
  if (!fn) {
    fn = ajv.compile(SCHEMAS[key]);
    compiled.set(key, fn);
  }
  return fn;
}

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath,
    keyword: e.keyword,
    message: e.message ?? e.keyword,
  }));
}

/** Validates already-parsed JSON against a contract. Never throws. */
export function validate<K extends ContractKey>(key: K, data: unknown): ValidationResult<ContractTypes[K]> {
  const fn = validatorFor(key);
  if (fn(data)) return { ok: true, value: data as ContractTypes[K] };
  return { ok: false, issues: toIssues(fn.errors) };
}

/** Parses JSON text and validates it. Never throws; invalid JSON is an issue at the root. */
export function parse<K extends ContractKey>(key: K, text: string): ValidationResult<ContractTypes[K]> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ path: "", keyword: "json", message: "not valid JSON" }] };
  }
  return validate(key, data);
}

/** Validates and returns the typed value, or throws ContractError. */
export function assertValid<K extends ContractKey>(key: K, data: unknown): ContractTypes[K] {
  const result = validate(key, data);
  if (!result.ok) throw new ContractError(key, result.issues);
  return result.value;
}
