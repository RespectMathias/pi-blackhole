/**
 * Regression test: openSettings must forward globalConfigDir to the modal.
 *
 * Without it, the modal falls back to getExtensionsDir() when initializing
 * its row values, so every untouched field shows the schema DEFAULT. On
 * save, allValues() then returns those defaults and save() writes them over
 * the user's real config file — the "config clobbered to defaults" bug.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const capturedOptions = vi.hoisted<Record<string, unknown>[]>(() => []);

vi.mock("../src/pi-base/settings/index.js", () => ({
  openSettingsModal: async (_ctx: unknown, options: unknown) => {
    capturedOptions.push(options as Record<string, unknown>);
  },
}));

import { ConfigManager } from "../src/pi-base/config-manager.js";

const testDir = join(tmpdir(), `pi-blackhole-modal-test-${Date.now()}`);

const DEFAULTS = {
  compaction: "auto",
  compactAfterTokens: 81_000,
  observeAfterTokens: 15_000,
  memory: true,
} as const;

const ctx = {
  cwd: testDir,
  ui: { notify: vi.fn() },
} as unknown as ExtensionContext;

beforeEach(() => {
  capturedOptions.length = 0;
});

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = testDir;
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("openSettings globalConfigDir forwarding", () => {
  it("forwards the ConfigManager configDir to the modal (no extensions-dir fallback)", async () => {
    const cm = new ConfigManager<Record<string, unknown>>({
      id: "test",
      label: "test",
      filename: "pi-blackhole-config.json",
      defaults: DEFAULTS,
      fields: () => [
        {
          key: "compaction",
          type: "enum",
          label: "Compaction",
          value: "auto",
          options: ["auto", "manual", "off"],
        },
        {
          key: "compactAfterTokens",
          type: "number",
          label: "Tokens",
          value: 185_000,
        },
        {
          key: "observeAfterTokens",
          type: "number",
          label: "Observe",
          value: 25_000,
        },
        { key: "memory", type: "boolean", label: "Memory", value: true },
      ],
    });

    const configDir = join(testDir, "pi-blackhole");
    await cm.openSettings(ctx, testDir, () => {}, configDir);

    expect(capturedOptions).toHaveLength(1);
    const opts = capturedOptions[0];
    // The bug: this was undefined → body.ts used getExtensionsDir() →
    // rows initialized from DEFAULTS → save clobbered the real config.
    expect(opts.globalConfigDir).toBe(configDir);
  });

  it("openBlackholeSettings resolves GLOBAL_CONFIG_DIR under the agent dir", async () => {
    // blackhole-settings.ts computes GLOBAL_CONFIG_DIR at module scope,
    // so it must be imported after PI_CODING_AGENT_DIR is set.
    const { openBlackholeSettings } =
      await import("../src/pi-base/blackhole-settings.js");

    await openBlackholeSettings(ctx);

    expect(capturedOptions).toHaveLength(1);
    const opts = capturedOptions[0];
    expect(opts.globalConfigDir).toBe(join(testDir, "pi-blackhole"));
  });
});
