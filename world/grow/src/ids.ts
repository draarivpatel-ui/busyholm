// Runtime copies of the contract id lists grow() needs. @busyholm/contracts exports the same arrays,
// but importing its index at runtime also loads the ajv validators and JSON schemas, which the pure
// engine and the webview bundle must not carry. test/contract.test.ts holds these equal to the contracts.
import type { MilestoneId, ProgressionStructureId, StructureId, Tool } from "@busyholm/contracts";

export const TOOLS: readonly Tool[] = ["claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other"];

export const STRUCTURE_IDS: readonly StructureId[] = [
  "campfire", "tent", "bell_post", "noticeboard", "workshop_1", "well", "cottage_1", "garden_plots",
  "crossing", "watermill", "workshop_2", "cottage_2", "bell_tower", "bakery", "market_hall", "founders_stone",
];

export const PROGRESSION_STRUCTURE_IDS: readonly ProgressionStructureId[] = [
  "noticeboard", "workshop_1", "well", "cottage_1", "garden_plots", "crossing", "watermill",
  "workshop_2", "cottage_2", "bell_tower", "bakery", "market_hall",
];

export const MILESTONE_IDS: readonly MilestoneId[] = [
  "first_turn", "first_answer", "first_subagent", "two_tools_day", "turns_100", "streak_7", "turns_1000",
];
