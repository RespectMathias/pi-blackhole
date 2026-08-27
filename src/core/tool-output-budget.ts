import { textOf } from "./content.js";
import { estimateStringTokens } from "../om/tokens.js";

export interface ToolOutputBudgetResult {
  messages: any[];
  retainedTokens: number;
  omittedTokens: number;
  omittedCount: number;
  pendingCount: number;
}

const isToolOutput = (message: any): boolean =>
  message?.role === "toolResult" || message?.role === "bashExecution";

const outputText = (message: any): string => {
  if (message.role === "bashExecution") {
    return typeof message.output === "string" ? message.output : "";
  }
  if (typeof message.content === "string" || Array.isArray(message.content)) {
    return textOf(message.content);
  }
  return "";
};

const omissionMarker = (recallIndex?: number): string =>
  `[Tool output text omitted from active context; ${recallIndex === undefined ? "use recall" : `recall #${recallIndex}`}.]`;

const omitOutput = (message: any, recallIndex?: number): any => {
  const marker = omissionMarker(recallIndex);
  if (message.role === "bashExecution") return { ...message, output: marker };
  if (typeof message.content === "string") {
    return { ...message, content: marker };
  }
  if (Array.isArray(message.content)) {
    const nonText = message.content.filter(
      (part: any) => part?.type !== "text",
    );
    return {
      ...message,
      content: [{ type: "text", text: marker }, ...nonText],
    };
  }
  return { ...message, content: marker };
};

export function applyToolOutputBudget(
  messages: any[],
  maxTokens: number,
  recallIndexes: ReadonlyMap<number, number> = new Map(),
): ToolOutputBudgetResult {
  let lastSuccessfulAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message?.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    ) {
      lastSuccessfulAssistantIndex = i;
      break;
    }
  }

  let retainedTokens = 0;
  let omittedTokens = 0;
  let omittedCount = 0;
  let pendingCount = 0;
  let exhausted = false;
  let output = messages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isToolOutput(message)) continue;
    if (lastSuccessfulAssistantIndex < 0 || i > lastSuccessfulAssistantIndex) {
      pendingCount++;
      continue;
    }

    const tokens = estimateStringTokens(outputText(message));
    if (tokens === 0) continue;
    if (!exhausted && retainedTokens + tokens <= maxTokens) {
      retainedTokens += tokens;
      continue;
    }

    exhausted = true;
    omittedTokens += tokens;
    omittedCount++;
    if (output === messages) output = [...messages];
    output[i] = omitOutput(message, recallIndexes.get(i));
  }

  return {
    messages: output,
    retainedTokens,
    omittedTokens,
    omittedCount,
    pendingCount,
  };
}
