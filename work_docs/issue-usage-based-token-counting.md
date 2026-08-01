# Issue: chars/4 token estimation underreports actual usage — compaction & coverage triggers fire late

**Date:** 2026-08-01
**Status:** Investigation complete — evidence collected, fix designed, **not yet implemented** (pending review in a fresh session)
**Scope:** `src/om/ledger/progress.ts`, `src/om/tokens.ts`, `src/om/compaction-trigger.ts`, `src/om/consolidation.ts` (due-checks), `src/commands/memory.ts` (status display)
**Reproduce:** `node scripts/analyze-token-estimation.mjs 20`

---

## Summary

All of our pipeline triggers estimate token counts with a chars/4 heuristic (`estimateTokens` from `@earendil-works/pi-coding-agent` for messages, `chars/4` for strings). Across 20 real sessions this estimate **underreports actual model usage by ~20–35% on median** — and up to 2–4× in individual sessions. Consequences:

- **Auto-compaction** (`rawTokensSinceLastCompaction >= compactAfterTokens`): with defaults (81k threshold vs pi's ~84.5k hard limit), the estimate can **never reach the threshold before the hard limit** — auto-compaction effectively never fires proactively, only as an emergency at the context ceiling.
- **Observer/reflector/dropper coverage counters** (`rawTokensSince*Coverage >= reflect/observeAfterTokens`): fire late — in the live pi-blackhole-dev session the observer counter read ~22k while **actual new content since the last run was ~42k** (1.9× under).
- The `/blackhole-memory` status panel displays these underreported numbers, so the "triggers at X" readouts are not the real context size.

A third-party fork commit ([tavasti@360f24a](https://github.com/tavasti/pi-blackhole/commit/360f24a6d68b612cfc0858cc43e9514e8b5c9c97), "use actual model usage for compaction token estimation") fixes exactly this for the **compaction** counter by reading the last assistant message's `usage` metadata (via pi's public `calculateContextTokens`). Our review confirms the approach is sound and matches pi's own internal `estimateContextTokens()`. **But it cannot be copy-pasted to the coverage counters** — see the key architectural insight below.

---

## Background: the counters and code paths

| Counter | Function (src/om/ledger/progress.ts) | Used by |
|---|---|---|
| Since last compaction | `rawTokensSinceLastCompaction` (L151) | `src/om/compaction-trigger.ts`, `/blackhole-memory` |
| Since last observation run | `rawTokensSinceObservationCoverage` (L132) | `consolidation.ts` `observerDue`, status |
| Since last reflection run | `rawTokensSinceReflectionCoverage` (L136) | `consolidation.ts` `reflectorDue`, status |
| Since last drop | `rawTokensSinceDropCoverage` (L140) | `consolidation.ts` `dropperDue`, `runDropperStage`, status |

All delegate to `rawTokensSinceCoverage(entries, customType)` (L125) → `rawTokensAfterIndex(entries, latestCoverageIndex(...))`, which sums `estimateEntryTokens` (src/om/tokens.ts) over source entries (`message`, `custom_message`, `branch_summary`). `estimateEntryTokens` uses pi's `estimateTokens(message)` (chars/4-based) and `chars/4` for strings.

**Why it underreports:** chars/4 assumes ~4 chars/token; real tokenizers are ~2-2.5 chars/token for English and 1-2 tokens/char for CJK. Tool calls, JSON, and code are denser still. pi's own `estimateContextTokens()` exists precisely because of this.

## Upstream fork commit (reviewed)

`tavasti@360f24a` changes two files:

- **`src/om/tokens.ts`**: adds `hasUsageData(msg)` (assistant role + `calculateContextTokens(usage) > 0`) and `getUsageTokens(msg)`; imports `calculateContextTokens` from `@earendil-works/pi-coding-agent`.
- **`src/om/ledger/progress.ts`**: `rawTokensSinceLastCompaction` now finds the **last assistant message with usage after the compaction point**, returns `calculateContextTokens(usage) + estimateTokens(trailing messages)`, falling back to the old chars/4 behavior when no usage data exists.

Verified against our stack (pi `0.83.0`):

- `calculateContextTokens(usage)` — **public & typed** (declared in `dist/index.d.ts`; runtime check: `typeof === "function"`). Uses `usage.totalTokens` when present, else sums `input + output + cacheRead + cacheWrite`.
- `getLastAssistantUsage(entries)` and `estimateTokens` — also public.
- Real session messages carry `usage: { input, output, cacheRead, cacheWrite, totalTokens, cost }`; e.g. `input 4507 + cacheRead 6016 + output 174 = totalTokens 10697`.
- The fork commit has **no tests** and uses **tabs** (needs prettier normalization). Its `calculateContextTokens` import typechecks fine on 0.83.0.

The commit references pi issues #2068 (413 errors), #6879 (compaction never triggers), OpenClaw #70052 (CJK underestimation — same root cause).

## Evidence: 20 real sessions

Script: `scripts/analyze-token-estimation.mjs` — replays both counting methods over the N most recent session JSONLs, using pi's real `estimateTokens`/`calculateContextTokens`. Ratios are computed only over **marker-present** windows (well-defined "since coverage" semantics), with the window clamped to the current branch (last compaction's `firstKeptEntryId`), because the JSONL file retains pre-compaction bulk the runtime branch does not.

### Aggregate (thresholds from global config: observe 25k / reflect 80k / drop 80k / compact 185k)

```
observer   n= 11  est/usage median=0.76 min=0.59 max=7.99  | est>=thr:9 usage>=thr:12 (12 marker / 8 no-marker) | fires LATE:4 EARLY:1
reflector  n= 10  est/usage median=0.80 min=0.61 max=7.99  | est>=thr:3 usage>=thr:4  (11 marker / 9 no-marker) | fires LATE:1 EARLY:0
dropper    n=  0  est/usage median=n/a                     | est>=thr:7 usage>=thr:9  ( 1 marker /19 no-marker) | fires LATE:2 EARLY:0
compaction n= 15  est/usage median=0.68 min=0.00 max=1.05 | est>=thr:0 usage>=thr:1  (16 marker / 4 no-marker) | fires LATE:1 EARLY:0
```

- **est/usage < 1 = est underreports.** Compaction is worst (median 0.68); observer 0.76; reflector 0.80.
- **compaction est>=thr: 0 / usage>=thr: 1** — in 16 compacted sessions the estimate **never** crossed 185k while usage did once. Default users (81k threshold vs ~84.5k hard limit) are in the "never fires" regime.
- The `7.99` outlier is a degenerate edge: observer marker sitting immediately before the last compaction (window = summary + tiny tail, usage-delta includes pre-compaction context). Minor, not representative.
- The `dropper` row has no marker-present windows — drop markers are essentially never written (only 1 in 20 sessions), which is itself the separate dropper-gating issue (see docs/ or session notes on `dropperPoolFullnessThreshold`).

### Illustrative rows (live pi-blackhole-dev session, 2026-07-31T21-44-51-190Z)

```
observer      31619     53577   0.59  ...   est>=thr: true   usage>=thr: true
reflector     75106    101808   0.74  ...   est>=thr: false  usage>=thr: true
compaction   170010    223969   0.76  ...   est>=thr: false  usage>=thr: true
```

The reflector counter reads 75k (under 80k → not due) while actual is ~102k — the reflector was silently overdue. This matches the manual check: chars/4 ≈ 17.5k vs usage-delta ≈ 49.8k for the observer window.

## Key architectural insight: why the fork's function can't be reused verbatim for coverage

- **Compaction**: pi *rebuilds* the context after compacting (summary + new messages). The last assistant message's usage after the compaction point therefore **is** "tokens since compaction". The fork's logic is correct as-is.
- **Coverage markers** (`om.observations.recorded`, `om.reflections.recorded`, `om.observations.dropped`) are written **mid-context** — the context is not reset. The last usage after a marker would report the **whole context** (e.g. ~224k in the live session), not "since the marker". Applied naively, the counters would be permanently ≥ threshold → observer/reflector/dropper would run on **every** `agent_start` (runaway).

**Fix: usage-delta for coverage counters.**

```
newSinceMarker ≈ lastAssistantUsage(after marker) − lastAssistantUsage(before marker) + estimateTokens(trailing)
```

Both baselines are provider-accurate (model tokenizer), so the pre-marker context cancels out. Baseline choice barely matters (measured: 49,800 vs 48,470 with first-after-marker baseline). Fall back to chars/4 when no usage data exists (providers that don't report usage, fresh sessions, or no post-marker assistant turns).

## Proposed implementation

1. **`src/om/tokens.ts`** — add `hasUsageData(msg)` + `getUsageTokens(msg)` (fork's helpers, prettier-normalized, using public `calculateContextTokens`).
2. **`src/om/ledger/progress.ts`**:
   - `rawTokensSinceLastCompaction` → fork's usage+trailing logic (last usage after the compaction point; fallback chars/4).
   - `rawTokensSinceCoverage` (shared by all three coverage counters) → usage-delta logic; chars/4 fallback.
3. **Tests** — extend `tests/session-ledger-progress.test.ts` (usage-aware, delta, and fallback paths).
4. One commit on `dev`, attributing `tavasti@360f24a`.

The exact algorithms are already implemented and battle-tested in `scripts/analyze-token-estimation.mjs` (`usageSinceLastCompaction`, `usageDeltaSinceCoverage`).

## Risks / behavior changes (accept consciously)

- **Stages fire earlier in real terms** (observer/reflector/dropper roughly 1.3–2.9× more often). Thresholds become "actual context tokens" as the config literally says. With free-model fallback chains + cooldowns, expect more runs / more cooldown churn; consider raising thresholds after adopting.
- **Provider dependence**: some providers/models don't populate `usage` — the chars/4 fallback keeps those sessions on old behavior. `hasUsageData` skips zero/absent usage.
- **Status display** (`/blackhole-memory`) will show usage-accurate numbers — the "triggers at X" readouts become truthful.
- The user's current session is at ~224k actual context with `compactAfterTokens: 185000` — after the fix, auto-compaction (if re-enabled) fires at 185k actual instead of never.

## Open questions for the next session

1. Adopt the fork's compaction fix as-is, or also fold in the coverage-delta (this writeup's proposal)? Recommended: both, one commit.
2. Should the usage-delta live in `rawTokensSinceCoverage` (affects observer+reflector+dropper at once) or be opt-in per stage? Recommended: shared.
3. Threshold re-tuning after adoption — observe the new fire frequency for a few sessions before bumping.
4. `dropperPoolFullnessThreshold` (added 2026-08-01, default 0.1, user set 0.05) interacts here: dropper fires on pool fullness + new-data, and the new-data check uses `rawTokensSinceDropCoverage >= reflectAfterTokens` — usage-accurate counting changes that too.

## References

- Fork commit: `tavasti@360f24a6d68b612cfc0858cc43e9514e8b5c9c97` — `https://github.com/tavasti/pi-blackhole/commit/360f24a`
- pi exports (verified on `@earendil-works/pi-coding-agent@0.83.0`): `calculateContextTokens`, `getLastAssistantUsage`, `estimateTokens`
- pi's own `estimateContextTokens(messages)` — internal in `dist/core/compaction/compaction.js` (same algorithm; **not** re-exported from package root — only `calculateContextTokens` and `getLastAssistantUsage` are public)
- Session data: `~/.pi/agent/sessions/*/*.jsonl`
- Analysis script: `scripts/analyze-token-estimation.mjs`
