import { describe, expect, it } from "vitest";
import { InMemoryTaskStore } from "./task-store.js";

describe("InMemoryTaskStore", () => {
  it("creates isolated task/run identifiers and records append-only events", () => {
    const store = new InMemoryTaskStore();
    const first = store.create("read the page", "explore");
    const second = store.create("fill a form", "execute");
    store.addEvent(first.id, "task.created", { mode: first.mode });
    expect(first.id).not.toBe(second.id);
    expect(first.runId).not.toBe(second.runId);
    expect(store.get(first.id)?.events).toHaveLength(1);
    expect(store.get(second.id)?.events).toHaveLength(0);
  });
});
