#!/usr/bin/env node
/**
 * Analyze chars/4 token estimation vs actual model usage across real pi sessions.
 *
 * Motivation: our compaction + coverage counters (rawTokensSinceLastCompaction,
 * rawTokensSinceCoverage) estimate tokens as chars/4 via pi's estimateTokens().
 * This systematically underreports actual provider usage (often ~2-3x), so
 * auto-compaction and the observer/reflector/dropper thresholds fire late.
 *
 * This script replays both counting methods over real session JSONL files:
 *   - `est`   : current behavior — estimateTokens() over source entries since the
 *               last coverage marker / compaction (mirrors progress.ts).
 *   - `usage` : proposed behavior —
 *               * compaction: last assistant message's calculateContextTokens()
 *                 after the compaction point + estimate for trailing messages
 *                 (mirrors tavasti fork commit 360f24a / pi's estimateContextTokens).
 *               * coverage : usage DELTA — last assistant usage after the marker
 *                 minus last assistant usage before the marker + trailing estimate.
 *                 (Needed because coverage markers sit mid-context; the last usage
 *                 alone would report the whole context, not "since the marker".)
 *
 * Usage: node scripts/analyze-token-estimation.mjs [N]
 *   N = number of most-recent session files to analyze (default 20).
 *
 * See work_docs/issue-usage-based-token-counting.md for the full writeup.
 */
import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  calculateContextTokens,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";

const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const OM_TYPES = {
  observations: "om.observations.recorded",
  reflections: "om.reflections.recorded",
  drops: "om.observations.dropped",
};
const SOURCE_TYPES = new Set(["message", "custom_message", "branch_summary"]);

// ── config thresholds (from global config, with defaults) ────────────────
function loadThresholds() {
  const cfgPath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-blackhole",
    "pi-blackhole-config.json",
  );
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    return {
      observe: raw.observeAfterTokens ?? 25_000,
      reflect: raw.reflectAfterTokens ?? 80_000,
      drop: raw.reflectAfterTokens ?? 80_000,
      compact: raw.compactAfterTokens ?? 185_000,
    };
  } catch {
    return { observe: 25_000, reflect: 80_000, drop: 80_000, compact: 185_000 };
  }
}

// ── entry-level helpers (mirror src/om/tokens.ts + progress.ts) ──────────
function estimateStringTokens(text) {
  return Math.ceil(text.length / 4);
}

function estimateEntryTokens(entry) {
  if (entry.type === "message" && entry.message) {
    try {
      return estimateTokens(entry.message);
    } catch {
      return 0;
    }
  }
  if (entry.type === "custom_message" && entry.content) {
    const content = entry.content;
    if (typeof content === "string") return estimateStringTokens(content);
    if (Array.isArray(content)) {
      let total = 0;
      for (const block of content) {
        if (block.type === "text" && block.text)
          total += estimateStringTokens(block.text);
      }
      return total;
    }
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return estimateStringTokens(entry.summary);
  }
  return 0;
}

function isSourceEntry(entry) {
  return SOURCE_TYPES.has(entry.type);
}

function usageTokens(message) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  try {
    const t = calculateContextTokens(usage);
    return t > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

function rawTokensAfterIndex(entries, index) {
  let total = 0;
  for (let i = Math.max(0, index + 1); i < entries.length; i++) {
    if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
  }
  return total;
}

function latestCoverageIndex(entries, customType) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (
      e.type === "custom" &&
      e.customType === customType &&
      e.data &&
      typeof e.data.coversUpToId === "string"
    ) {
      return i;
    }
  }
  return -1;
}

function findLastCompactionIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compaction") return i;
  }
  return -1;
}

/** Index of the first entry in the runtime's current branch: the last
 *  compaction's firstKeptEntryId (or 0 when never compacted). The session
 *  JSONL file keeps pre-compaction messages; the runtime branch does not,
 *  so "since coverage" windows must be clamped to this boundary. */
function branchStartIndex(entries) {
  const ci = findLastCompactionIndex(entries);
  if (ci === -1) return 0;
  const fk = entries[ci].firstKeptEntryId;
  const fki = fk ? entries.findIndex((e) => e.id === fk) : -1;
  return fki === -1 ? ci : fki;
}

/** est tokens after index, clamped to the current branch start. */
function rawTokensAfterIndexBounded(entries, index) {
  const start = Math.max(0, index + 1, branchStartIndex(entries));
  let total = 0;
  for (let i = start; i < entries.length; i++) {
    if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
  }
  return total;
}

// ── proposed counters ─────────────────────────────────────────────────────
/** Usage-delta for coverage markers: last usage after marker − last usage
 *  before marker + trailing estimate. Falls back to estimate when no usage. */
function usageDeltaSinceCoverage(entries, customType) {
  const marker = latestCoverageIndex(entries, customType);
  const after = marker + 1;

  let baseline = 0; // last assistant usage at/before the marker (0 = fresh context)
  let ceiling = undefined;
  let ceilingIndex = -1;
  for (let i = branchStartIndex(entries); i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "message" || !e.message) continue;
    const t = usageTokens(e.message);
    if (t === undefined) continue;
    if (i < after) baseline = t;
    else {
      ceiling = t;
      ceilingIndex = i;
    }
  }
  if (ceiling === undefined) return rawTokensAfterIndexBounded(entries, marker);

  let trailing = 0;
  for (let j = ceilingIndex + 1; j < entries.length; j++) {
    if (isSourceEntry(entries[j])) trailing += estimateEntryTokens(entries[j]);
  }
  return Math.max(0, ceiling - baseline) + trailing;
}

/** Usage-based for compaction: context is rebuilt after compacting, so the
 *  last assistant usage after the compaction point IS "tokens since". */
function usageSinceLastCompaction(entries) {
  const compactionIndex = findLastCompactionIndex(entries);
  let startIndex;
  if (compactionIndex === -1) {
    startIndex = -1;
  } else {
    const firstKept = entries[compactionIndex].firstKeptEntryId;
    const firstKeptIndex = firstKept
      ? entries.findIndex((e) => e.id === firstKept)
      : -1;
    startIndex = firstKeptIndex === -1 ? compactionIndex : firstKeptIndex - 1;
  }

  let lastUsage = undefined;
  let lastUsageIndex = -1;
  for (let i = entries.length - 1; i > startIndex; i--) {
    const e = entries[i];
    if (e.type !== "message" || !e.message) continue;
    const t = usageTokens(e.message);
    if (t !== undefined) {
      lastUsage = t;
      lastUsageIndex = i;
      break;
    }
  }
  if (lastUsage === undefined) return rawTokensAfterIndex(entries, startIndex);

  let trailing = 0;
  for (let j = lastUsageIndex + 1; j < entries.length; j++) {
    if (isSourceEntry(entries[j])) trailing += estimateEntryTokens(entries[j]);
  }
  return lastUsage + trailing;
}

// ── session discovery ─────────────────────────────────────────────────────
function findSessions(n) {
  const seen = new Set();
  const files = [];
  for (const dir of readdirSync(SESSIONS_DIR)) {
    const full = path.join(SESSIONS_DIR, dir);
    let entries = [];
    try {
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(full, f);
      let real;
      try {
        real = realpathSync(p);
      } catch {
        continue;
      }
      if (seen.has(real)) continue; // dedupe symlinks/hardlinks
      seen.add(real);
      try {
        files.push({ path: real, mtime: statSync(real).mtimeMs });
      } catch {
        /* skip */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, n);
}

function parseEntries(filePath) {
  const entries = [];
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed */
    }
  }
  return entries;
}

// ── report ────────────────────────────────────────────────────────────────
const th = loadThresholds();
const N = Number(process.argv[2]) || 20;
const sessions = findSessions(N);

const stages = [
  { name: "observer", type: OM_TYPES.observations, threshold: th.observe },
  { name: "reflector", type: OM_TYPES.reflections, threshold: th.reflect },
  { name: "dropper", type: OM_TYPES.drops, threshold: th.drop },
  { name: "compaction", type: null, threshold: th.compact },
];

const agg = Object.fromEntries(
  stages.map((s) => [
    s.name,
    {
      ratios: [],
      estOver: 0,
      usageOver: 0,
      late: 0, // est<thr but usage>=thr (est underreports → fires late)
      early: 0, // est>=thr but usage<thr
      withMarker: 0,
      noMarker: 0,
      noUsage: 0,
    },
  ]),
);

console.log(
  `Analyzing ${sessions.length} most recent sessions under ${SESSIONS_DIR}\n` +
    `Thresholds: observe=${th.observe} reflect=${th.reflect} drop=${th.drop} compact=${th.compact}\n` +
    `(est = current chars/4 estimate over the branch window; usage = proposed usage-based count; marker = index of last coverage marker / compaction, -1 = none)`,
);
console.log(
  "stage      est       usage     ratio  marker  est>=thr  usage>=thr  session",
);

let lines = 0;
for (const s of sessions) {
  const entries = parseEntries(s.path);
  const name = path
    .basename(s.path)
    .replace(/_019[a-f0-9-]+\.jsonl$/, "")
    .slice(-22);
  for (const stage of stages) {
    const marker =
      stage.type === null
        ? findLastCompactionIndex(entries)
        : latestCoverageIndex(entries, stage.type);
    const est = rawTokensAfterIndexBounded(entries, marker);
    const usage =
      stage.type === null
        ? usageSinceLastCompaction(entries)
        : usageDeltaSinceCoverage(entries, stage.type);
    const ratio = usage > 0 ? (est / usage).toFixed(2) : "n/a";
    const estOver = est >= stage.threshold;
    const usageOver = usage >= stage.threshold;

    const a = agg[stage.name];
    if (marker >= 0) a.withMarker++;
    else a.noMarker++;
    if (usage > 0 && marker >= 0) a.ratios.push(est / usage);
    if (usage === 0 && est === 0) a.noUsage++;
    if (estOver) a.estOver++;
    if (usageOver) a.usageOver++;
    if (usageOver && !estOver) a.late++;
    if (estOver && !usageOver) a.early++;

    lines++;
    if (lines <= 70) {
      console.log(
        `${stage.name.padEnd(10)} ${String(est).padStart(8)} ${String(usage).padStart(9)} ${String(ratio).padStart(6)}  ${String(marker).padStart(6)}  ${String(estOver).padStart(8)}  ${String(usageOver).padStart(9)}  ${name}`,
      );
    }
  }
}

// ── aggregate ─────────────────────────────────────────────────────────────
console.log(
  "\n── Aggregate (ratios over marker-present, non-empty windows) ──",
);
for (const stage of stages) {
  const a = agg[stage.name];
  const ratios = a.ratios;
  ratios.sort((x, y) => x - y);
  const med = ratios.length
    ? ratios[Math.floor(ratios.length / 2)].toFixed(2)
    : "n/a";
  const min = ratios.length ? ratios[0].toFixed(2) : "n/a";
  const max = ratios.length ? ratios[ratios.length - 1].toFixed(2) : "n/a";
  const trigger =
    a.late || a.early
      ? `| fires LATE:${a.late} EARLY:${a.early}`
      : "| triggers agree";
  console.log(
    `${stage.name.padEnd(10)} n=${String(ratios.length).padStart(3)}  est/usage median=${med} min=${min} max=${max}  | est>=thr:${a.estOver} usage>=thr:${a.usageOver} (windows: ${a.withMarker} marker / ${a.noMarker} no-marker)${a.noUsage ? ` no-usage:${a.noUsage}` : ""} ${trigger}`,
  );
}
console.log(
  `\nSessions analyzed: ${sessions.length} | est/usage < 1 means est UNDERREPORTS usage (fires late); > 1 overreports (fires early)`,
);
