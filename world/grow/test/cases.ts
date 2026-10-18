// The determinism corpus: case i of a master seed, plus the grow() options it runs with. Pure, so the
// Node runner (test/hash-worlds.ts) and the browser bundle (test/webview/) build identical inputs.
import type { Choices, Ledger } from "@busyholm/contracts";
import type { GrowOptions } from "../src/grow.ts";
import { dayNumber, dayString } from "../src/days.ts";
import { genCase } from "./gen.ts";

export const DETERMINISM_MASTER = 0x5eed0008;
export const DETERMINISM_COUNT = 1000;

export interface DeterminismInput {
  readonly seed: number;
  readonly ledger: Ledger;
  readonly choices: Choices;
  readonly options: GrowOptions;
}

export function determinismInput(master: number, i: number): DeterminismInput {
  const c = genCase(master, i);
  const edition = i % 5 === 4 ? "demo" : "full";
  // Every seventh case folds only part of its history, as the replay does.
  const options: GrowOptions = i % 7 === 3
    ? { edition, asOfDay: dayString(dayNumber(c.ledger.founded_day) + (i % 40)) }
    : { edition };
  return { seed: c.seed, ledger: c.ledger, choices: c.choices, options };
}
