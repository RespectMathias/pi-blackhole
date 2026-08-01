# Issue: chars/4 token estimation underreports actual usage — compaction & coverage triggers fire late

**Date:** 2026-08-01
**Status:** Investigation complete — evidence collected over the **full session archive (698 unique sessions)**; fix designed; default-threshold calibration planned. **Planning only — no code changes yet** (significant refactor with cost/churn implications for auto-install users).
**Scope:** `src/om/ledger/progress.ts`, `src/om/tokens.ts`, `src/om/compaction-trigger.ts`, `src/om/consolidation.ts` (due-checks), `src/commands/memory.ts` (status display)
**Reproduce:** `node scripts/analyze-token-estimation.mjs` (all sessions → `tmp/token-estimation-report.md`) or `--defaults` (code-default thresholds → `tmp/token-estimation-report-defaults.md`); tracked math-only review artifact: `node scripts/analyze-token-estimation.mjs --summary work_docs/token-estimation-results.md`

---

## Summary

All of our pipeline triggers estimate token counts with a chars/4 heuristic (`estimateTokens` from `@earendil-works/pi-coding-agent` for messages, `chars/4` for strings). Across the **full session archive (698 unique sessions)** this estimate **underreports actual model usage by ~20%–39% on median per stage** — and far worse in individual windows (up to 75×). Consequences:

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

### Illustrative rows (live pi-blackhole-dev session, 2026-07-31T21-44-51-190Z — snapshot; the session is live and growing)

```
observer      31619     53577   0.59  ...   est>=thr: true   usage>=thr: true
reflector     75106    101808   0.74  ...   est>=thr: false  usage>=thr: true
compaction   170010    223969   0.76  ...   est>=thr: false  usage>=thr: true
```

The reflector counter reads 75k (under 80k → not due) while actual is ~102k — the reflector was silently overdue. This matches the manual check: chars/4 ≈ 17.5k vs usage-delta ≈ 49.8k for the observer window.

### Full-universe algorithmic run (698 sessions)

`scripts/analyze-token-estimation.mjs` (no arg = **all** unique sessions, realpath-deduped) is now the reproducible reference: it replays both counting methods over the whole archive and writes a full report (every window, aggregate, calibration) to `tmp/`. `tmp/` is gitignored; the reports regenerate on demand.

**Primary basis — the author's actual config** (observe 25k / reflect+drop 80k / compact 185k; stable for weeks, defaults never used — config has no `dropAfterTokens`, so dropper inherits `reflectAfterTokens`):

| stage | n marker-windows | est/usage median | est fires | usage fires | churn× | LATE | EARLY | same-fire-count T' |
|---|---|---|---|---|---|---|---|---|
| observer | 243 | 0.80 | 297 | 377 | **1.3** | 98 | 18 | ~36.3k |
| reflector | 176 | 0.82 | 98 | 165 | **1.7** | 77 | 11 | ~99.3k |
| dropper | 5 | 0.61 | 191 | 286 | **1.5** | 109 | 15 | ~103.2k |
| compaction | 339 | 0.61 | 3 | 22 | **7.3** | 20 | 1 | ~262k |

Actual usage at trigger-decision points: observer p50 31.8k / p90 110.8k / p95 130k / max 238k; reflector p50 40.9k / p90 114.4k / p95 131.4k; dropper p50 66.9k / p90 141.8k / p95 163.7k; compaction p50 67k / p90 143.5k / p95 167.6k.

Read: est underreports ~20% (observer/reflector) to ~39% (dropper/compaction) on median. **LATE** = windows where the trigger should have fired under truthful counting but didn't (98 missed observer runs, 109 missed dropper runs). **churn×** = how many more fires truthful counting produces with unchanged thresholds. Coverage stages: **1.3–1.7× more calls** — not the feared 2–3×, because est already fires a lot (observer crosses 25k in 43% of windows). Compaction: 7.3× but from a base of 3 fires (and auto-compaction is `off` in this config anyway).

**Secondary surface — code defaults** (15k/25k/25k/81k, what auto-install users get): churn 1.2–1.6×; same-fire-count T' observer ~23.6k, reflector ~36.3k, dropper ~40.1k, compaction ~108.2k. Note compaction est fires 172× at the default 81k vs 3× at the author's 185k — the shipped default compacts ~57× more often than the author's setup; any default bump directly moves that.

## Context-window evolution & cost-safety (planning addendum)

**Context windows have grown materially in the last year.** The minimum coding-agent context sits around **256k**; most frontier models run **1M**; only local coder models top out at **~128k**. The shipped presets predate this:

| preset | README target | observe | reflect/drop | compact |
|---|---|---|---|---|
| low | ~32–64k | 5k | 10k | 30k |
| medium (default) | ~128k | 15k | 25k | 81k |
| high | ~200k+ | 20k | 40k | 180k |

**Cost framing.** The extension is used by **hundreds to thousands of users** — and the majority are **not** on free models: they use **real, expensive API keys** and rely on **auto-compaction heavily** (the author's own config, with `compaction: off` and free-tier fallback chains, is the *cheap* outlier, not the norm). For that majority:

- Truthful counting with unchanged thresholds means 1.3–1.7× more observer/reflector/dropper calls — a silent **30–70% increase in paid token spend per session**. At thousands of users this is a real, ongoing cost change shipped without consent.
- **Auto-compaction is a core, frequently-hit feature for them** — and it is exactly the stage with the worst underreporting (median est/usage 0.61) and the most dramatic churn (7.3× at 185k; at the default 81k the est counter already fires 172× and truthful counting raises it further). A compaction fix that fires meaningfully earlier than before is a *cost increase on every long session* for these users — but it also protects them from hitting hard context limits, which is the point of the feature.
- This is why the fork's surface is deliberately *smaller*: it only fixes **compaction** (rare-ish, high-value context-safety) rather than the **chatty coverage workers** (observer/reflector/dropper fire on a large fraction of sessions). The usage-delta change for coverage stages is the part that needs cost-mitigation design — for paid users it is the dominant cost lever.

For the author specifically the cost is not dollars — every worker model in the fallback chains is free-tier (OpenRouter/Cerebras/stepfun/z.ai) — but **free-tier rate limits and fallback churn**: more fires → more 429s → more cooldown cycling.

**Decision (proposed, not implemented):** ship truthful counting **together with** default threshold bumps (at least the medium and high presets) so the fire frequency users actually experience stays roughly constant, and document the change in **CONFIG.md, llms.txt, README.md** so auto-install users are not surprised. Draft numbers in the next section are discussion inputs only.

## Draft default-bump proposal (discussion inputs — not decided)

Method: combine (a) the same-fire-count calibration (the threshold that reproduces today's fire count under truthful counting: defaults observer ~23.6k, reflector ~36.3k, dropper ~40.1k, compaction ~108.2k) with (b) the README's 60–70%-of-context compaction rule, re-targeted to 2026 context sizes. Values are deliberately left open for a decision session.

| preset | new target | observe | reflect/drop | compact | rationale |
|---|---|---|---|---|---|
| low (local coder models) | ~128k | ~10k | ~20k | ~85k (67% of 128k) | retarget from 32–64k to the real local ceiling; the 128k presets are the new minimum, not the default |
| medium (default) | ~256k | ~30k | ~50k | ~160k (63% of 256k) | new minimum coding-agent window; sits above same-fire counts → *fewer* fires than today's defaults |
| high | ~1M | ~60k | ~120k | ~600k (60% of 1M) | frontier models; compaction becomes a true ceiling guard on huge windows |

Interactions to check before finalizing:
- `observeAfterTokens` vs `observerChunkMaxTokens` (default 40k) — observe can't meaningfully exceed chunk size.
- Compaction vs pi's per-model hard limit: keep ~60–70% of the *model's* window, not the preset's label.
- Whether the bump ships **atomically with the counting change** (recommended: cost-neutral adoption) or in a later release (existing users first see the 1.3–1.7× fire increase with their custom thresholds).

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
5. **Default threshold bumps + docs (same release, separate commit)** — raise the medium/high presets per the draft proposal; update CONFIG.md (threshold tables + env vars), llms.txt (context-size presets), README.md (Configuration presets + tuning guidance). Ship atomically with the counting change so auto-install users see a roughly constant fire frequency, not a silent 1.3–1.7× spend increase.

The exact algorithms are already implemented and battle-tested in `scripts/analyze-token-estimation.mjs` (`usageSinceLastCompaction`, `usageDeltaSinceCoverage`).

## Risks / behavior changes (accept consciously)

- **Stages fire earlier in real terms**: with unchanged thresholds, algorithmic churn is **1.3–1.7× for coverage stages** (observer 1.3, reflector 1.7, dropper 1.5) and **7.3× for compaction** (from a base of 3 fires at 185k). Default bumps (draft proposal above) are the mitigation so auto-install users see roughly constant frequency. Thresholds become "actual context tokens" as the config literally says. With free-model fallback chains + cooldowns, expect more runs / more cooldown churn; consider raising thresholds after adopting.
- **Provider dependence**: some providers/models don't populate `usage` — the chars/4 fallback keeps those sessions on old behavior. `hasUsageData` skips zero/absent usage.
- **Status display** (`/blackhole-memory`) will show usage-accurate numbers — the "triggers at X" readouts become truthful.
- The user's current session is at ~224k actual context with `compactAfterTokens: 185000` — after the fix, auto-compaction (if re-enabled) fires at 185k actual instead of never.

## Open questions for the next session

1. Adopt the fork's compaction fix as-is, or also fold in the coverage-delta (this writeup's proposal)? Recommended: both, one commit — but see (5): given the paid-user base, a **staged rollout** (compaction fix alone first — fork's scope, minimal cost surface — then coverage-delta with the threshold bumps) is worth considering.
2. Should the usage-delta live in `rawTokensSinceCoverage` (affects observer+reflector+dropper at once) or be opt-in per stage? Recommended: shared.
3. Exact new default values for medium/high presets (draft in the proposal section; decide after a decision session).
4. `dropperPoolFullnessThreshold` (added 2026-08-01, default 0.1, user set 0.05) interacts here: dropper fires on pool fullness + new-data, and the new-data check uses `rawTokensSinceDropCoverage >= reflectAfterTokens` — usage-accurate counting changes that too.
5. **Cost-sign-off for the user base**: the majority run paid keys and rely on auto-compaction. Confirm the fire-frequency targets (constant, or slightly lower for cost headroom) before shipping; document the change so users can re-tune.

## Appendix: UX & rollout (breaking-change surface)

### A. Presets in the config modal

- The `/blackhole configure` overlay (`src/om/configure-overlay.ts`) manages individual fields grouped in sections (Compaction, Memory, …) and opens via `ctx.ui.custom({ overlay: true })`. The pi-base settings modal already supports **scope actions** — `save-global` / `save-project` / `discard` / `cancel` (`src/pi-base/settings/body.ts` L77–81, `getScopeActionOptions` L713).
- **Proposal:** add a **Presets** option/tab to the configure modal — pick one of the three presets (low / medium / high, values per the draft-bump proposal above), which pre-fills the affected keys (`observeAfterTokens`, `reflectAfterTokens`, `compactAfterTokens`, plus the chunk/pool sizes from the README preset blocks), then save to **global or project-local** exactly like every other field (existing scope actions).
- **Why:** after the threshold bumps, users must match presets to their model's context window (256k min / 1M common / 128k local). Hand-editing N number fields is error-prone; a one-step preset picker + the same save-scope flow makes it a 5-second task.

### B. One-time breaking-change warning at session start

- **The problem:** the install base is fire-and-forget — users install, never read changelogs (GitHub or otherwise), and would absorb the usage-counting + threshold change as a silent behavior/cost shift. Provenance of the change is required.
- **Proposal:** once per session, at `agent_start`, show a small yellow line in the status overlay / transient `ctx.ui` note, e.g. *"pi-blackhole: token counting now uses real model usage; thresholds changed — check /blackhole configure"*, with auto-dismiss (a few seconds) or an explicit dismiss.
- **Hook point:** the existing `pi.on("agent_start", …)` handlers (`src/om/consolidation.ts` L461, `src/om/compaction-trigger.ts` L76) — or a dedicated handler — compare the persisted last-seen version against a `BREAKING_SINCE` constant, show the note once, then persist.
- **Provenance / deprecation (must not linger forever):**
  1. Persist a `lastSeenVersion` field in a small state file in `~/.pi/agent/pi-blackhole/` — same pattern as `pi-blackhole-cooldown.json` (`src/om/cooldown.ts` L28/L53/L64).
  2. The warning renders only when `lastSeenVersion < BREAKING_SINCE`; after first display it is suppressed until the next breaking release bumps the constant.
  3. **Programmatic removal:** when the breaking change is old (e.g. 2+ minor versions later), the warning code + state key are deleted entirely — a release-checklist note so it never stays accidentally.
- **Why a UI note and not a CHANGELOG link:** users don't open changelogs; a single dismissible yellow line is the only channel with guaranteed reach. It is explicitly scoped to breaking releases so it cannot become nagging.

### C. Combined strategy framing (why the three levers go together)

- Adopting usage-delta counting **everywhere** (dropper/observer/reflector included, not just compaction) raises run frequency ~30–70% (their chars/4 counters undercount by 20–40%).
- **Threshold bumps** (draft proposal above) bring frequency back to ≈ today's for default users.
- **Tool-result trimming** (head+tail: first **1000 + last 1000 chars**, only for results > 4096 chars — the `TRIM` policy in `scripts/analyze-token-estimation.mjs`, tunable via `--trim-head/--trim-tail/--trim-threshold`) **plus thinking-block trimming** (head+tail **20%/20%** for blocks > 4096 chars — 27k-char thinking blocks observed; tunable via `--think-head-pct/--think-tail-pct`). Combined effect on the observer's serialized input (which is ~51% tool-result text, ~22% thinking): **median 31% / p90 61% tokens saved** (tool results: median 51% of their tokens; thinking: median 1% but p90 48% / max 60% — a tail phenomenon that only matters in long sessions, but matters there a lot). Going tighter than 1000/1000 (e.g. 500/500) buys only ~3pp more (34% median) — **1000/1000 is the chosen default**, 500/500 is the aggressive option.
- Net for default users: **≈ same run frequency, lower tokens per run, truthful thresholds.** Power users keep custom thresholds (their frequency rises — surfaced via B).

## References

- Fork commit: `tavasti@360f24a6d68b612cfc0858cc43e9514e8b5c9c97` — `https://github.com/tavasti/pi-blackhole/commit/360f24a`
- pi exports (verified on `@earendil-works/pi-coding-agent@0.83.0`): `calculateContextTokens`, `getLastAssistantUsage`, `estimateTokens`
- pi's own `estimateContextTokens(messages)` — internal in `dist/core/compaction/compaction.js` (same algorithm; **not** re-exported from package root — only `calculateContextTokens` and `getLastAssistantUsage` are public)
- Session data: `~/.pi/agent/sessions/*/*.jsonl`
- Analysis script: `scripts/analyze-token-estimation.mjs`
