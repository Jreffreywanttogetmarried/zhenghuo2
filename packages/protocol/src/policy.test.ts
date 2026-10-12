import { describe, expect, it } from "vitest";
import { browserActionSchema, isActionAllowed } from "./index.js";

const base = { actionId: "a1", protocolVersion: 1 as const };

describe("browser action policy", () => {
  it("rejects sensitive typing", () => {
    const action = browserActionSchema.parse({ ...base, type: "type", ref: "el-1", text: "password=secret", sensitive: true });
    expect(isActionAllowed(action).allowed).toBe(false);
    expect(isActionAllowed(action).risk).toBe("blocked");
  });

  it("requires confirmation for submit-like controls", () => {
    const action = browserActionSchema.parse({ ...base, type: "click", ref: "el-2" });
    const observation = { pageVersion: "v1", url: "https://example.com", title: "Example", text: "", elements: [{ ref: "el-2", role: "button", name: "Submit order", visible: true, disabled: false }] };
    expect(isActionAllowed(action, observation).risk).toBe("high");
  });

  it("reuses the current tab by default and accepts an explicit new-tab request", () => {
    const reuse = browserActionSchema.parse({ ...base, type: "open_url", url: "https://example.com" });
    const newTab = browserActionSchema.parse({ ...base, type: "open_url", url: "https://example.com", newTab: true });
    expect(reuse).toMatchObject({ type: "open_url", newTab: false });
    expect(newTab).toMatchObject({ type: "open_url", newTab: true });
  });
});
