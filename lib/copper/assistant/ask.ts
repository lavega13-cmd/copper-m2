"use server";

// Module 2: the server action the Ask Copper chat calls. It streams the
// conversation to the model through callStream (lib/ai/call.ts), with or
// without the tools, and sends back each step as it happens, so the panel can
// show Copper thinking and using its tools. The contract is in
// specs/module-2/spec.md.
import { stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { COPPER_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import type { Progress, ToolStep } from "@/lib/copper/assistant/progress";
import { copperTools } from "@/lib/copper/assistant/tools";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
};

export type AskCopperResult = { progress: Live<Progress> };

/** At most this many model steps (tool calls plus the reply) per question. */
const MAX_STEPS = 5;

const EMPTY_REPLY =
  "Sorry, I couldn't come up with an answer to that. Could you try asking another way?";
const FAILED_REPLY =
  "Sorry, something went wrong on my end. Please try again in a moment.";

/** A fresh copy, so earlier updates never change underneath whoever holds them. */
function snapshot(progress: Progress): Progress {
  return { ...progress, steps: progress.steps.map((step) => ({ ...step })) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function askCopper(
  request: AskCopperRequest,
): Promise<AskCopperResult> {
  const { messages, useTools } = request;
  const { live, update, done } = createLive<Progress>();

  // Return straight away and read the stream in the background, so the panel
  // can draw each step as it happens.
  void stream(messages, useTools, update, done);
  return { progress: live };
}

async function stream(
  messages: ChatMessage[],
  useTools: boolean,
  update: (value: Progress) => void,
  done: (value: Progress) => void,
) {
  const progress: Progress = { steps: [], reply: "", status: "working" };
  const toolStep = (id: string): ToolStep | undefined =>
    progress.steps.find(
      (step): step is ToolStep => step.type === "tool" && step.id === id,
    );

  try {
    // Tools off: no instructions and no tools, just the conversation, so the
    // model answers from memory alone. Thought summaries go on both paths.
    const result = callStream(
      { module: 2, feature: "ask-copper" },
      useTools
        ? {
            instructions: COPPER_INSTRUCTIONS,
            messages,
            tools: copperTools,
            stopWhen: stepCountIs(MAX_STEPS),
            providerOptions: THOUGHT_SUMMARIES,
          }
        : { messages, providerOptions: THOUGHT_SUMMARIES },
    );

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking") last.text += part.text;
          else progress.steps.push({ type: "thinking", text: part.text });
          break;
        }
        case "tool-input-start":
          // Named before its input is known, so the panel can say which tool
          // Copper picked while it's still filling in the details.
          progress.steps.push({
            type: "tool",
            id: part.id,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: part.toolCallId,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (!step) continue;
          step.output = part.output;
          step.state = "done";
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          if (!step) continue;
          step.output = errorText(part.error);
          step.state = "error";
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot(progress));
    }

    // Only an empty reply is replaced; a real one is never added to.
    if (!progress.reply.trim()) progress.reply = EMPTY_REPLY;
    done(snapshot({ ...progress, status: "done" }));
  } catch (error) {
    console.error("[ask-copper]", errorText(error));
    if (!progress.reply.trim()) progress.reply = FAILED_REPLY;
    done(snapshot({ ...progress, status: "error" }));
  }
}
