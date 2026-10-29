// @vitest-environment node
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalValue, readLive } from "@/lib/ai/live";
import type { Progress } from "@/lib/copper/assistant/progress";

// The endings the module's acceptance tests don't cover: an empty reply and a
// model that fails. Both finish with a short apology instead of hanging.

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

async function ask() {
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  return askCopper({
    messages: [{ role: "user", content: "Hi" }],
    useTools: true,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("askCopper", () => {
  it("apologizes when the model says nothing, and still finishes as done", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage,
          },
        ]),
      }),
    });
    const result = await finalValue((await ask()).progress);
    expect(result.status).toBe("done");
    expect(result.reply).toMatch(/sorry/i);
  });

  it("finishes as an error with an apology when the model fails", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("model is down");
      },
    });
    const result = await finalValue((await ask()).progress);
    expect(result.status).toBe("error");
    expect(result.reply).toMatch(/sorry/i);
  });

  it("hands out a fresh copy on every update", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "reasoning-start", id: "r" },
          { type: "reasoning-delta", id: "r", delta: "Thinking" },
          { type: "reasoning-end", id: "r" },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Hello" },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage,
          },
        ]),
      }),
    });
    const updates: Progress[] = [];
    for await (const update of readLive((await ask()).progress))
      updates.push(update);
    const withThinking = updates.filter((u) => u.steps.length > 0);
    expect(withThinking.length).toBeGreaterThan(1);
    expect(withThinking[0].steps[0]).not.toBe(withThinking[1].steps[0]);
    expect(updates.at(-1)).toMatchObject({ reply: "Hello", status: "done" });
  });
});
