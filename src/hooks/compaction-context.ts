import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectAppendOnlyContext } from "../core/compaction-chain.js";
import { applyToolOutputBudget } from "../core/tool-output-budget.js";
import { debugLog } from "../om/debug-log.js";
import type { Runtime } from "../om/runtime.js";

const buildRecallIndexes = (
  messages: any[],
  branchEntries: any[],
  allEntries: any[],
): Map<number, number> => {
  const globalIndexById = new Map<string, number>();
  let messageIndex = 0;
  for (const entry of allEntries) {
    if (entry?.type !== "message" || !entry.message) continue;
    if (entry.id != null) globalIndexById.set(String(entry.id), messageIndex);
    messageIndex++;
  }

  const indexByMessage = new Map<any, number>();
  const indexByToolCallId = new Map<string, number>();
  const duplicateToolCallIds = new Set<string>();
  const indexedShellMessages: Array<{ message: any; index: number }> = [];
  for (const entry of branchEntries) {
    if (entry?.type !== "message" || !entry.message) continue;
    const index = globalIndexById.get(String(entry.id));
    if (index === undefined) continue;
    indexByMessage.set(entry.message, index);
    if (entry.message.role === "bashExecution") {
      indexedShellMessages.push({ message: entry.message, index });
    }
    const toolCallId = entry.message.toolCallId;
    if (typeof toolCallId === "string" && toolCallId.length > 0) {
      if (indexByToolCallId.has(toolCallId))
        duplicateToolCallIds.add(toolCallId);
      else indexByToolCallId.set(toolCallId, index);
    }
  }

  const result = new Map<number, number>();
  messages.forEach((message, index) => {
    let transcriptIndex = indexByMessage.get(message);
    const toolCallId = message?.toolCallId;
    if (
      transcriptIndex === undefined &&
      typeof toolCallId === "string" &&
      !duplicateToolCallIds.has(toolCallId)
    ) {
      transcriptIndex = indexByToolCallId.get(toolCallId);
    }
    if (transcriptIndex === undefined && message?.role === "bashExecution") {
      const matches = indexedShellMessages.filter(
        (candidate) =>
          candidate.message.command === message.command &&
          candidate.message.output === message.output &&
          candidate.message.exitCode === message.exitCode &&
          candidate.message.timestamp === message.timestamp,
      );
      if (matches.length === 1) transcriptIndex = matches[0].index;
    }
    if (transcriptIndex !== undefined) result.set(index, transcriptIndex);
  });
  return result;
};

/** Project compaction checkpoints and budget historical tool outputs. */
export function registerCompactionContextHook(
  pi: ExtensionAPI,
  runtime: Runtime,
): void {
  pi.on("context", (event: any, ctx: any) => {
    runtime.ensureConfig(ctx.cwd ?? process.cwd());
    const dbg = (ev: string, data?: Record<string, unknown>) =>
      debugLog(ev, data, runtime.config.debugLog === true);
    let branchEntries: any[];
    let projected: any[];
    try {
      branchEntries = ctx.sessionManager.getBranch();
      projected = projectAppendOnlyContext(event.messages, branchEntries);
    } catch (error) {
      // Keep Pi's complete fallback summary if the projection cannot be built.
      dbg("compaction_context.projection_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      const budget = runtime.config.retainedToolOutputMaxTokens;
      let recallIndexes = new Map<number, number>();
      try {
        const allEntries = ctx.sessionManager.getEntries?.();
        if (Array.isArray(allEntries)) {
          recallIndexes = buildRecallIndexes(
            projected,
            branchEntries,
            allEntries,
          );
        }
      } catch {
        // A generic recall marker is safer than an incorrect transcript index.
      }
      const result =
        typeof budget === "number" && budget > 0
          ? applyToolOutputBudget(projected, budget, recallIndexes)
          : {
              messages: projected,
              retainedTokens: 0,
              omittedTokens: 0,
              omittedCount: 0,
              pendingCount: 0,
            };
      const messages = result.messages;
      if (messages === event.messages) return;
      if (result.omittedCount > 0) {
        dbg("compaction_context.tool_outputs_omitted", {
          retainedTokens: result.retainedTokens,
          omittedTokens: result.omittedTokens,
          omittedCount: result.omittedCount,
          pendingCount: result.pendingCount,
        });
      }
      return { messages };
    } catch (error) {
      // Budgeting is optional; never discard a valid append projection.
      dbg("compaction_context.tool_output_budget_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return projected === event.messages ? undefined : { messages: projected };
    }
  });
}
