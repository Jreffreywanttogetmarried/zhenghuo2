import type { BrowserAction, PageObservation } from "@browser-agent/protocol";

export type TaskStatus = "queued" | "running" | "waiting_confirmation" | "paused" | "completed" | "failed" | "stopped";
export interface TaskEvent { id: string; at: string; kind: string; payload: unknown; }
export interface Task {
  id: string; goal: string; mode: "explore" | "plan" | "execute"; status: TaskStatus;
  runId: string; createdAt: string; updatedAt: string; observation?: PageObservation;
  pendingAction?: BrowserAction; events: TaskEvent[]; error?: string;
}

export class InMemoryTaskStore {
  private readonly tasks = new Map<string, Task>();
  create(goal: string, mode: Task["mode"]): Task {
    const now = new Date().toISOString();
    const task: Task = { id: crypto.randomUUID(), runId: crypto.randomUUID(), goal, mode, status: "queued", createdAt: now, updatedAt: now, events: [] };
    this.tasks.set(task.id, task); return task;
  }
  get(id: string) { return this.tasks.get(id); }
  update(id: string, patch: Partial<Task>) { const task = this.tasks.get(id); if (!task) return; Object.assign(task, patch, { updatedAt: new Date().toISOString() }); return task; }
  addEvent(id: string, kind: string, payload: unknown) { const task = this.tasks.get(id); if (!task) return; task.events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), kind, payload }); task.updatedAt = new Date().toISOString(); }
  list() { return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
}
