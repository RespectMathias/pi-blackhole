// Best-effort build hook. Runs via `prepare` on install (dev clones, git deps)
// and on pack/publish. Designed to NEVER break a consumer install:
//
//   - tsup present  → build dist/ (real build errors still fail loudly —
//                     that's a dev/CI bug, not a consumer environment issue)
//   - tsup missing  → skip silently. Registry consumers never run this
//                     script at all; git consumers without devDependencies
//                     simply fall back to index.ts at load time.
//   - husky present → (re)install git hooks, best-effort (dev checkouts only)
//
// Zero runtime dependencies: plain node, no pnpm/npm/bun requirement.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const bin = (name) =>
  join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );

// 1. Build dist when the toolchain is available.
const tsup = bin("tsup");
if (existsSync(tsup)) {
  const r = spawnSync(tsup, [], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error("[prepare] tsup build failed");
    process.exit(r.status ?? 1);
  }
}

// 2. Git hooks, best-effort (only meaningful in a dev checkout).
const husky = bin("husky");
if (existsSync(husky)) {
  const r = spawnSync(husky, [], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.warn(`[prepare] husky skipped (non-fatal): exit ${r.status}`);
  }
}
