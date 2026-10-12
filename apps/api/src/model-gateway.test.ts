import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekGateway } from "./model-gateway.js";

describe("DeepSeekGateway", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("returns a safe finish action when no API key is configured", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const gateway = new DeepSeekGateway();
    const action = await gateway.nextAction({ goal: "inspect this page", mode: "explore" });
    expect(action.type).toBe("finish");
  });

  it("validates and normalizes structured model output", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ type: "finish", summary: "done" }) } }] })));
    const gateway = new DeepSeekGateway();
    const action = await gateway.nextAction({ goal: "inspect this page", mode: "execute", observation: {
      pageVersion: "page-1", url: "https://example.com", title: "Example", text: "", elements: [],
    } });
    expect(action).toMatchObject({ type: "finish", protocolVersion: 1, expectedPageVersion: "page-1" });
    expect(action.actionId).toBeTruthy();
  });

  it("rejects malformed model output instead of returning an executable action", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: "not-json" } }] })));
    const gateway = new DeepSeekGateway();
    await expect(gateway.nextAction({ goal: "do something", mode: "execute" })).rejects.toThrow("invalid JSON");
  });
});
