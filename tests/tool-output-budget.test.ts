import { describe, expect, it } from "vitest";
import { applyToolOutputBudget } from "../src/core/tool-output-budget.js";

describe("applyToolOutputBudget", () => {
  it("keeps an output that exactly fits the budget without cloning history", () => {
    const messages = [
      { role: "toolResult", toolName: "read", content: "12345678" },
      { role: "assistant", content: "consumed" },
    ];

    const result = applyToolOutputBudget(messages, 2);

    expect(result.messages).toBe(messages);
    expect(result.retainedTokens).toBe(2);
    expect(result.omittedCount).toBe(0);
  });

  it("masks shell output while retaining execution metadata", () => {
    const messages = [
      {
        role: "bashExecution",
        command: "build",
        output: "x".repeat(8),
        exitCode: 1,
      },
      { role: "assistant", content: "consumed" },
    ];

    const result = applyToolOutputBudget(messages, 1);

    expect(result.messages[0]).toMatchObject({
      role: "bashExecution",
      command: "build",
      exitCode: 1,
    });
    expect(result.messages[0].output).toContain("omitted from active context");
    expect(messages[0].output).toBe("xxxxxxxx");
  });

  it("replaces text while preserving non-text tool-result content", () => {
    const image = { type: "image", data: "encoded", mimeType: "image/png" };
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "capture",
        content: [{ type: "text", text: "x".repeat(8) }, image],
      },
      { role: "assistant", content: "consumed" },
    ];

    const result = applyToolOutputBudget(messages, 1, new Map([[0, 4]]));

    expect(result.messages[0].content[0].text).toContain("recall #4");
    expect(result.messages[0].content[1]).toBe(image);
    expect(messages[0].content[0].text).toBe("xxxxxxxx");
  });

  it("protects outputs when no successful assistant has consumed them", () => {
    const messages = [
      { role: "bashExecution", command: "build", output: "x".repeat(20) },
    ];

    const result = applyToolOutputBudget(messages, 1);

    expect(result.messages).toBe(messages);
    expect(result.pendingCount).toBe(1);
  });

  it("does not treat errored or aborted assistants as consumption boundaries", () => {
    for (const stopReason of ["error", "aborted"]) {
      const messages = [
        { role: "toolResult", toolName: "read", content: "x".repeat(20) },
        { role: "assistant", stopReason, content: [] },
      ];

      const result = applyToolOutputBudget(messages, 1);

      expect(result.messages).toBe(messages);
      expect(result.pendingCount).toBe(1);
    }
  });

  it("treats non-string/non-array tool-result content as textless", () => {
    const messages = [
      {
        role: "toolResult",
        toolName: "custom",
        content: { data: "opaque" },
      },
      { role: "assistant", content: "consumed" },
    ];

    const result = applyToolOutputBudget(messages, 1);

    expect(result.messages).toBe(messages);
    expect(result.retainedTokens).toBe(0);
    expect(result.omittedCount).toBe(0);
  });

  it("leaves image-only results unchanged after the text budget is exhausted", () => {
    const image = { type: "image", data: "encoded", mimeType: "image/png" };
    const messages = [
      { role: "toolResult", toolName: "capture", content: [image] },
      { role: "toolResult", toolName: "old", content: "x".repeat(8) },
      { role: "assistant", content: "consumed" },
    ];

    const result = applyToolOutputBudget(messages, 1);

    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1].content).toContain("text omitted");
  });
});
