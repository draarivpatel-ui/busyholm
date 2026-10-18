# WP-08 calibration: usage profiles and the economy they set

Written 2026-10-12. Counts only. This file holds summary numbers; no per-day series, dates of use, project names, paths, ids or text are in the repo.

## 1. What was measured, and how

**Source: one user (the author), one Mac.** The plan called for the author's counts plus 3 to 5 testers' exports. Only the author's logs exist today, so every profile below is calibrated on one power user. Treat the numbers as a first anchor, to be re-checked when testers' counts-only exports arrive.

- **Logs read**: this Mac's Claude Code transcripts (`~/.claude/projects`) and Codex rollouts (`~/.codex/sessions`), 2026-07-07 to 2026-10-12 (98 calendar days, 85 active days).
- **Reader**: read-only parsers of the agents' own transcripts and rollouts, counting records only. Turn, interrupt and session counts were independently recounted from raw record structure and matched (Claude human prompts 1116 of 1116 and 49 of 49; 58 interrupt records for 58 interrupted turns).
- **Definitions** (matching the ledger): a turn is a completed main-session exchange started by a human prompt, with an agent reply and no interrupt; subagent turns are counted apart and earn nothing; working time is the span from a prompt to the last main-thread record of that turn, credited to the local day (local time zone).
- **Hands-on versus automated**: Claude `sdk-*` entrypoints and Codex `exec`, `mcp` and subagent threads count as automated. This is a heuristic, not proof: two origins could be either.

## 2. The numbers (hands-on, both tools, per active day, whole history)

| metric | p10 | p25 | median | p75 | p90 | max | mean |
|---|---|---|---|---|---|---|---|
| completed turns | 2.4 | 6 | 12 | 19 | 31.6 | 64 | 14.6 |
| working minutes (turn span, clipped at 2 h) | 18 | 74 | 160 | 274 | 429 | 1188 | 206 |
| working minutes (turn span, clipped at 30 min) | 18 | 45 | 82 | 155 | 258 | 533 | 113 |
| sessions touched | 1 | 1 | 2 | 3 | 6 | 18 | 2.7 |

- Active days per week: 5.7 (mean over weeks with any activity), 6.3 over the last 30 days.
- Turns per working hour: 4.2 (2 h clip) to 7.8 (30 min clip). Real turns are long: the median Claude turn is 2.5 minutes, p90 is 31 minutes.
- Heavy days: the days above the p90 carry 30% of all turns.
- Automated use (scripts, orchestrators) adds about 14% more turns; it is excluded from the profiles.

**Which working-time column to trust.** The ledger counts time in the `working` state only, which excludes waiting on a permission prompt and the gap before the user's next prompt. The turn span includes some of that, so the true ledger value sits between the two columns. 67 turns hit the 2 h clip and supply 134 of the 313 working hours, so the 2 h column is an upper bound. The profiles use 2.5 h for a median day, between the two medians (1.4 h and 2.7 h) and nearer the upper one because long autopilot turns are mostly real working time.

**What the data changed.** SPEC 4.5 assumed a typical day of 30 turns and 3 h (10 turns an hour). Real use is far fewer, longer turns: 12 turns in about 2.5 h. With the spec's old curve (1 plank a turn for the first 20) a real median day would have earned 12 planks and needed about 32 active days to the village. The curve was rebuilt around the measured day (section 4).

## 3. The profiles (sim/profiles.ts)

| profile | per active day | active days | basis |
|---|---|---|---|
| light | 6 turns, 1 h, one tool | 4 a week (Mon, Tue, Thu, Sat) | the p25 day; fewer days than the author (ASSUMPTION) |
| typical | 12 turns, 2.5 h, Claude plus Codex one day a week | 5 a week (Mon to Fri) | the median day; one day a week fewer than the author (ASSUMPTION: most users are not daily) |
| no-prompts | typical, with zero needs-you episodes | 5 a week | SPEC Revision 1 item 6: an agent on auto-approve or in a sandbox |
| heavy | 200 turns, 20 h across two tools side by side | 6 a week | SPEC 4.5's burner, far above the author's p90 day (32 turns, 7 h) |
| max | every counter at the ledger cap, four tools | 7 a week | stress case only, not a pacing target |

## 4. The economy (src/config.ts)

Per active day (at least one completed main-session turn), all tools summed:

| resource | rule | typical day | daily cap | cap / typical |
|---|---|---|---|---|
| planks | 6 for an active day, then 1.5 a turn for turns 1 to 10 and 1 a turn for turns 11 to 30 | 23 | 41 (at 30 turns) | 1.78 |
| stone | 2 for an active day, then 1 per 10 min of working time for the first 90 min and 1 per 40 min up to 6 h | 12.5 | 17.5 (at 6 h) | 1.40 |
| seeds | 1 for an active day, 1 more while the streak is 3 or more (2 rest days a week allowed) | 2 | 2 | 1 |

- **Why stone is front-loaded.** The ledger's working time for a median day is only known to lie between 1.4 h and 2.7 h (section 2). With the first 90 minutes counting most, a median day earns 10 to 12.5 stone anywhere in that range, so the pacing does not hinge on which estimate is right. Light's 1 h day earns 8.
- **Nothing else earns.** Prompts (`needs_you`), answer speed (no longer in the ledger since contracts r1), sessions, errors, recoveries, limit hits, interrupted turns, subagent turns and tokens earn nothing and gate nothing.
- **Founding crate 18 planks, 9 stone, 3 seeds** (SPEC 4.5 said 15 / 6 / 3). The author's real first logged day had 2 turns and 3 minutes of working time, which with the old crate built only two structures. With 18 / 9, any active first day builds the noticeboard, the first workshop and the well.
- **Structure costs unchanged from SPEC 4.5** (402 planks and 191 stone for all 12).
- **One extra condition: the market hall waits for 12 finished active days.** No amount of volume can compress the village below two working weeks of use; it binds only for heavy and max.
- **Decorations**: 24 items, 66 seeds in total; 8 are available from the start, the rest unlock with the structure they belong to; the pumpkin patch and leaf pile are autumn items, the snowman and sledge winter items (owned forever, shown in season; `src/seasons.ts`).
- **Backfill** (opt-in history): the same daily curves over up to 31 days, then capped at 50 planks, 24 stone and 6 seeds, credited on the founding day; history never counts toward live stats or milestones.
- **Steam demo**: three progression structures and six decorations, then building stops while the ledger keeps counting; the full edition on the same ledger catches up at once.

## 5. Pacing results (npm run sim, from world/grow)

Day 1 is the founding day. Canonical profiles, no day-to-day variation:

| profile | built day 1 | built day 7 | built day 14 | hamlet (6) | village (12) | all 24 decorations |
|---|---|---|---|---|---|---|
| light | 3 | 5 | 7 | day 9 | day 44 | day 74 |
| typical | 3 | 6 | 9 | day 4 | day 23 | day 45 |
| no-prompts | 3 | 6 | 9 | day 4 | day 23 | day 45 |
| heavy | 4 | 9 | 12 | day 2 | day 14 | day 38 |
| max | 4 | 10 | 12 | day 2 | day 13 | day 33 |

Acceptance (SPEC 9.1 WP-08 test 2): light and typical build at least 3 on day 1; typical has 3 unbuilt on day 14; typical reaches the village on day 23 (window 18 to 28); heavy is 23 / 14 = 1.64 times as fast (limit 2.2), and even the max stress case is 23 / 13 = 1.77. A user with no permission prompts builds on exactly the same days as typical. Heavy and max are held by the market hall's 12-active-day condition; without it heavy would finish about two days sooner. Decorations come from seeds, which do not grow with volume, so every profile collects all 24 in about five to eleven weeks.

**Day-to-day variation** (`node sim/spread.ts`: 200 runs per profile, each day's turns and minutes scaled by a seeded 0.6 to 1.4, and one day in ten flipped between active and rest; this variation model is an ASSUMPTION):

| profile | village day: min | p10 | median | p90 | max |
|---|---|---|---|---|---|
| light | 37 | 41 | 46 | 51 | 57 |
| typical | 18 | 22 | 24 | 29 | 31 |
| heavy | 13 | 14 | 16 | 18 | 20 |

All 200 typical and light runs build at least 3 on day 1, and all 200 typical runs have an unbuilt structure on day 14. Typical lands in the 18 to 28 window in 178 of 200 runs (89%); the misses are all late (days 29 to 31), because diminishing returns make an uneven week earn less than a flat one. The typical / heavy village-day ratio (same seed) has median 1.57 and exceeds 2.2 in 1 of 200 runs (2.21, a slow typical run against a fast heavy run).

**The author's own history, replayed.** Feeding the 85 real active days (hands-on, counts only, kept in `/tmp`, not in the repo) through `grow()` from the first logged day: 3 structures on day 1, 7 on day 14, the hamlet on day 5 and the village on day 28 with either working-time estimate, at 23.4 planks and 9.5 to 11.7 stone per active day; 11 of 85 days hit the plank cap and 3 to 17 the stone cap. So the measured mean day earns about what the typical profile earns, but real first weeks are lighter and lumpier than a flat profile, which puts a real user at the late end of the 18 to 28 window even at six active days a week. That is acceptable for a cozy game (about four weeks to the village), and it is the main reason the curve was not made stingier.

## 6. Known limits

- **One user.** The profiles rest on one power user's 85 days. Re-run this calibration on testers' counts-only exports before the demo ships.
- **Different tools side by side still add.** Since contracts r1 the ledger's working time is wall time per tool, so several sessions of one tool never add up, but Claude Code and Codex running at the same time still do. The 6 h stone cap bounds it (two tools side by side for 3 h earn what one tool earns in 6 h, never more than 17.5 stone a day). A day-level wall time is proposed in `contracts/CHANGES.md`.
- **Many tiny turns** earn more planks than a few long ones, up to the 30-turn cap (41 planks, 1.78 times a typical day). Turns are the only count of finished work episodes the ledger has; the cap is what keeps it honest.
- **Seasons** are not in World v1, so `grow()` cannot stop a snowman being bought in October; the shop (WP-11) should offer seasonal items only in season using `decorationInSeason()`.
