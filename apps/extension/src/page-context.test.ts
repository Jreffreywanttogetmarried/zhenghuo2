import { describe, expect, it } from "vitest";
import { observationSchema } from "@browser-agent/protocol";
import { canInjectContentScript, createNavigationOnlyObservation } from "./page-context.js";

describe("browser page context", () => {
  it("allows a task to begin from a browser-owned new tab without trying to inject into it", () => {
    expect(canInjectContentScript("chrome://newtab/")).toBe(false);
    expect(canInjectContentScript("https://www.bilibili.com/")).toBe(true);
    expect(observationSchema.safeParse(createNavigationOnlyObservation("chrome://newtab/", "新标签页")).success).toBe(true);
  });
});
