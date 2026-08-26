import { describe, expect, it } from "vitest";
import { buildAppendOnlyDetails } from "../src/core/compaction-chain.js";
import { registerCompactionContextHook } from "../src/hooks/compaction-context.js";

const details = buildAppendOnlyDetails({
  branchEntries: [],
  manualRebase: false,
  freshSummary: "[Goal]\nfirst",
  aggregateSummary: "[Goal]\nfirst",
  trailingSummary: "current tail",
  currentCoverage: {
    firstCoveredEntryId: "m1",
    lastCoveredEntryId: "m2",
    firstKeptEntryId: "m3",
    sourceMessageCount: 2,
  },
  tokensBefore: 1000,
  sections: ["Goal"],
  previousSummaryUsed: false,
});

const branch = [
  {
    id: "c1",
    type: "compaction",
    timestamp: 10,
    summary: "complete fallback",
    details,
  },
];

describe("append context hook", () => {
  it("replaces the exact fallback with the active immutable chain", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook(
      {
        on: (name: string, callback: (event: any, ctx: any) => any) => {
          if (name === "context") handler = callback;
        },
      } as any,
      { config: { debugLog: false }, ensureConfig: () => {} } as any,
    );

    const result = handler!(
      {
        messages: [
          {
            role: "compactionSummary",
            summary: "complete fallback",
            tokensBefore: 1000,
            timestamp: 10,
          },
          { role: "user", content: "raw tail", timestamp: 20 },
        ],
      },
      { sessionManager: { getBranch: () => branch } },
    );

    expect(result.messages[0].summary).toBe(details.segment.summary);
    expect(result.messages[1]).toMatchObject({
      role: "custom",
      content: "current tail",
      display: false,
    });
    expect(result.messages[2].content).toBe("raw tail");
  });

  it("returns no override when projection cannot be proved safe", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook(
      {
        on: (_name: string, callback: (event: any, ctx: any) => any) => {
          handler = callback;
        },
      } as any,
      { config: { debugLog: false }, ensureConfig: () => {} } as any,
    );

    const result = handler!(
      { messages: [{ role: "compactionSummary", summary: "different" }] },
      { sessionManager: { getBranch: () => branch } },
    );
    expect(result).toBeUndefined();
  });

  it("keeps a successful append projection when tool budgeting cannot read a payload", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook(
      {
        on: (_name: string, callback: (event: any, ctx: any) => any) => {
          handler = callback;
        },
      } as any,
      {
        config: {
          debugLog: false,
          retainedToolOutputMaxTokens: 1,
        },
        ensureConfig: () => {},
      } as any,
    );

    const result = handler!(
      {
        messages: [
          { role: "compactionSummary", summary: "complete fallback" },
          { role: "toolResult", toolName: "odd", content: { value: 1 } },
          { role: "assistant", content: "consumed" },
        ],
      },
      {
        sessionManager: {
          getBranch: () => branch,
          getEntries: () => branch,
        },
      },
    );

    expect(result.messages[0].summary).toBe(details.segment.summary);
    expect(result.messages[1]).toMatchObject({
      role: "custom",
      customType: "blackhole-compaction-tail",
    });
  });

  it("applies tool budgeting after a successful append projection", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook(
      {
        on: (_name: string, callback: (event: any, ctx: any) => any) => {
          handler = callback;
        },
      } as any,
      {
        config: {
          debugLog: false,
          retainedToolOutputMaxTokens: 1,
        },
        ensureConfig: () => {},
      } as any,
    );

    const result = handler!(
      {
        messages: [
          { role: "compactionSummary", summary: "complete fallback" },
          { role: "toolResult", toolName: "read", content: "abcdefgh" },
          { role: "assistant", content: "consumed" },
        ],
      },
      {
        sessionManager: {
          getBranch: () => branch,
          getEntries: () => branch,
        },
      },
    );

    expect(result.messages[0].summary).toBe(details.segment.summary);
    expect(result.messages[2].content).toContain("omitted from active context");
  });
});

describe("retained tool-output budget", () => {
  const registerBudgetHandler = (budget: number, branchEntries: any[] = []) => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerCompactionContextHook(
      {
        on: (_name: string, callback: (event: any, ctx: any) => any) => {
          handler = callback;
        },
      } as any,
      {
        config: {
          debugLog: false,
          retainedToolOutputMaxTokens: budget,
        },
        ensureConfig: () => {},
      } as any,
    );
    return (messages: any[]) =>
      handler!(
        { messages },
        {
          sessionManager: {
            getBranch: () => branchEntries,
            getEntries: () => branchEntries,
          },
        },
      );
  };

  it("retains newest tool outputs first and masks older outputs", () => {
    const apply = registerBudgetHandler(2);
    const messages = [
      { role: "toolResult", toolName: "old", content: "12345678" },
      { role: "assistant", content: "used old output" },
      { role: "toolResult", toolName: "new", content: "abcdefgh" },
      { role: "assistant", content: "used new output" },
    ];

    const result = apply(messages);

    expect(result.messages[0].content).toContain("omitted from active context");
    expect(result.messages[1]).toBe(messages[1]);
    expect(result.messages[2]).toBe(messages[2]);
    expect(result.messages[3]).toBe(messages[3]);
  });

  it("masks an oversized historical output", () => {
    const apply = registerBudgetHandler(1);
    const messages = [
      { role: "toolResult", toolName: "read", content: "x".repeat(20) },
      { role: "assistant", content: "consumed" },
    ];

    const result = apply(messages);

    expect(result.messages[0].content).toContain("omitted from active context");
    expect(result.messages[0]).toMatchObject({
      role: "toolResult",
      toolName: "read",
    });
  });

  it("preserves interleaved conversation while masking exhausted tool outputs", () => {
    const apply = registerBudgetHandler(1);
    const messages = [
      { role: "user", content: "question" },
      { role: "toolResult", toolName: "old", content: "a".repeat(8) },
      { role: "assistant", content: "analysis" },
      { role: "toolResult", toolName: "new", content: "b".repeat(4) },
      { role: "assistant", content: "answer" },
    ];

    const result = apply(messages);

    expect(result.messages).toHaveLength(messages.length);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1].content).toContain("omitted from active context");
    expect(result.messages[2]).toBe(messages[2]);
    expect(result.messages[3]).toBe(messages[3]);
    expect(result.messages[4]).toBe(messages[4]);
  });

  it("protects trailing tool results until an assistant consumes them", () => {
    const apply = registerBudgetHandler(1);
    const messages = [
      { role: "toolResult", toolName: "old", content: "a".repeat(8) },
      { role: "assistant", content: "calling another tool" },
      { role: "toolResult", toolName: "pending", content: "b".repeat(20) },
    ];

    const result = apply(messages);

    expect(result.messages[0].content).toContain("omitted from active context");
    expect(result.messages[2]).toBe(messages[2]);
  });

  it("adds a stable recall index when the tool result maps to a session entry", () => {
    const oldResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: "abcdefgh",
    };
    const consumed = { role: "assistant", content: "consumed" };
    const branchEntries = [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content: "question" },
      },
      { id: "t1", type: "message", message: oldResult },
      { id: "a1", type: "message", message: consumed },
    ];
    const apply = registerBudgetHandler(1, branchEntries);

    const result = apply([oldResult, consumed]);

    expect(result.messages[0].content).toContain("recall #1");
  });

  it("maps a structured-cloned shell output to its recall index", () => {
    const shellResult = {
      role: "bashExecution",
      command: "build",
      output: "abcdefgh",
      exitCode: 0,
      timestamp: 20,
    };
    const consumed = { role: "assistant", content: "consumed", timestamp: 30 };
    const branchEntries = [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content: "question", timestamp: 10 },
      },
      { id: "b1", type: "message", message: shellResult },
      { id: "a1", type: "message", message: consumed },
    ];
    const apply = registerBudgetHandler(1, branchEntries);

    const result = apply(structuredClone([shellResult, consumed]));

    expect(result.messages[0].output).toContain("recall #1");
  });
});
