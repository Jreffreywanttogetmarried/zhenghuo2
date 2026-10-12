import { describe, expect, it } from "vitest";
import { browserActionSchema, isActionAllowed } from "@browser-agent/protocol";

const base = { actionId: "test-action", protocolVersion: 1 as const };

describe("extension browser safety policy", () => {
  it("requires confirmation before navigating to another origin", () => {
    const action = browserActionSchema.parse({ ...base, type: "open_url", url: "https://other.example" });
    const observation = { pageVersion: "v1", url: "https://example.com", title: "Example", text: "", elements: [] };
    expect(isActionAllowed(action, observation)).toMatchObject({ allowed: false, risk: "high" });
  });
  it("blocks typing into password fields even if the model omits a sensitive flag", () => {
    const action = browserActionSchema.parse({ ...base, type: "type", ref: "password-field", text: "secret", sensitive: false });
    const observation = { pageVersion: "v1", url: "https://example.com", title: "Example", text: "", elements: [{ ref: "password-field", role: "textbox", name: "Password", inputType: "password", visible: true, disabled: false }] };
    expect(isActionAllowed(action, observation)).toMatchObject({ allowed: false, risk: "blocked" });
  });
});
