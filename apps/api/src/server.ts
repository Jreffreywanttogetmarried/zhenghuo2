import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import dotenv from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserActionSchema, isActionAllowed, observationSchema, wireMessageSchema } from "@browser-agent/protocol";
import { DeepSeekGateway } from "./model-gateway.js";
import { InMemoryTaskStore } from "./task-store.js";

dotenv.config({ path: resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../.env") });

const app = Fastify({ logger: true });
await app.register(cors, {
  origin(origin, callback) {
    if (!origin || origin === "http://localhost" || origin === "http://127.0.0.1" || origin.startsWith("chrome-extension://")) callback(null, true);
    else callback(new Error("Origin is not allowed"), false);
  },
});
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 2 } });
const store = new InMemoryTaskStore();
const model = new DeepSeekGateway();
const fileContextByTask = new Map<string, string>();
const fileIdByTask = new Map<string, string>();
const uploadedFiles = new Map<string, { name: string; mimeType: string; bytes?: Buffer }>();
const PARSER_URL = process.env.PARSER_URL ?? "http://127.0.0.1:8790";
const MAX_ACTIONS_PER_TASK = 40;
const MAX_TASK_AGE_MS = 30 * 60 * 1000;

app.get("/health", async () => ({ ok: true, service: "browser-agent-api", now: new Date().toISOString() }));

app.post("/api/files/parse", async (request, reply) => {
  try {
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: "Select a file to parse" });
    const bytes = await upload.toBuffer();
    const form = new FormData();
    form.append("file", new Blob([Uint8Array.from(bytes).buffer], { type: upload.mimetype }), upload.filename);
    const parsed = await fetch(`${PARSER_URL}/parse`, { method: "POST", body: form, signal: AbortSignal.timeout(90_000) });
    const body = await parsed.json().catch(() => ({})) as { name?: string; sizeBytes?: number; text?: string; truncated?: boolean; detail?: string };
    if (!parsed.ok) return reply.code(parsed.status).send({ error: body.detail ?? "File parsing failed" });
    const fileId = crypto.randomUUID();
    if (bytes.byteLength <= 8 * 1024 * 1024 && uploadedFiles.size < 10) {
      uploadedFiles.set(fileId, { name: body.name ?? upload.filename, mimeType: upload.mimetype, bytes });
      const retentionTimer = setTimeout(() => uploadedFiles.delete(fileId), 30 * 60 * 1000);
      retentionTimer.unref();
    }
    return { fileId, name: body.name, sizeBytes: body.sizeBytes, text: body.text, truncated: body.truncated, canBrowserUpload: uploadedFiles.has(fileId), retention: "request-only" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "File parsing failed";
    if (error && typeof error === "object" && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "File is larger than 50 MiB" });
    return reply.code(503).send({ error: `File parser unavailable: ${message}` });
  }
});

app.get<{ Params: { id: string } }>("/api/files/:id/content", async (request, reply) => {
  const file = uploadedFiles.get(request.params.id);
  if (!file?.bytes) return reply.code(404).send({ error: "File expired or too large for browser upload" });
  return { name: file.name, mimeType: file.mimeType, base64: file.bytes.toString("base64") };
});

app.post<{ Body: { goal: string; mode?: "explore" | "plan" | "execute"; fileContext?: string; fileId?: string } }>("/api/tasks", async (request, reply) => {
  const goal = request.body?.goal?.trim();
  if (!goal || goal.length > 10_000) return reply.code(400).send({ error: "goal must be between 1 and 10000 characters" });
  if (request.body.mode !== undefined && !["explore", "plan", "execute"].includes(request.body.mode)) return reply.code(400).send({ error: "mode must be explore, plan, or execute" });
  if (request.body.fileContext && request.body.fileContext.length > 100_000) return reply.code(413).send({ error: "Parsed file content is too large" });
  const task = store.create(goal, request.body.mode ?? "execute");
  if (request.body.fileContext) {
    fileContextByTask.set(task.id, request.body.fileContext);
    const retentionTimer = setTimeout(() => fileContextByTask.delete(task.id), 30 * 60 * 1000);
    retentionTimer.unref();
  }
  if (request.body.fileId && uploadedFiles.has(request.body.fileId)) fileIdByTask.set(task.id, request.body.fileId);
  store.addEvent(task.id, "task.created", { goal, mode: task.mode });
  return reply.code(201).send({ task });
});

app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
  const task = store.get(request.params.id);
  return task ? { task } : reply.code(404).send({ error: "task not found" });
});

app.get("/api/tasks", async () => ({ tasks: store.list() }));

app.post<{ Params: { id: string }; Body: { observation: unknown } }>("/api/tasks/:id/observe", async (request, reply) => {
  const task = store.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "task not found" });
  const parsed = observationSchema.safeParse(request.body?.observation);
  if (!parsed.success) return reply.code(400).send({ error: "invalid observation", details: parsed.error.flatten() });
  const actionEvents = task.events.filter((event) => event.kind === "agent.action_proposed");
  if (actionEvents.length >= MAX_ACTIONS_PER_TASK || Date.now() - Date.parse(task.createdAt) > MAX_TASK_AGE_MS) {
    store.update(task.id, { status: "paused", error: "任务达到安全动作数或运行时长上限" });
    fileContextByTask.delete(task.id);
    store.addEvent(task.id, "policy.limit_reached", { maxActions: MAX_ACTIONS_PER_TASK, maxAgeMs: MAX_TASK_AGE_MS });
    return { task: store.get(task.id), action: null, blocked: true, reason: "任务达到安全上限，请检查页面后重新开始。" };
  }
  const lastProposal = [...task.events].reverse().find((event) => event.kind === "agent.action_proposed");
  const observationSignature = `${parsed.data.url}|${parsed.data.pageVersion}`;
  if (lastProposal?.payload && (lastProposal.payload as { observationSignature?: string }).observationSignature === observationSignature) {
    const repeated = actionEvents.filter((event) => (event.payload as { observationSignature?: string }).observationSignature === observationSignature).length;
    if (repeated >= 3) {
    store.update(task.id, { status: "paused", error: "检测到同一页面重复尝试，已暂停以避免操作循环" });
      fileContextByTask.delete(task.id);
      store.addEvent(task.id, "policy.loop_detected", { observationSignature, repeats: repeated });
      return { task: store.get(task.id), action: null, blocked: true, reason: "检测到重复操作循环，任务已暂停。" };
    }
  }
  store.update(task.id, { observation: parsed.data, status: "running" });
  store.addEvent(task.id, "browser.observed", { pageVersion: parsed.data.pageVersion, url: parsed.data.url });
  try {
    const action = await model.nextAction({ goal: task.goal, mode: task.mode, observation: parsed.data, fileContext: fileContextByTask.get(task.id), fileId: fileIdByTask.get(task.id), previousError: task.error });
    if (action.type === "upload_file" && (!fileIdByTask.has(task.id) || action.fileId !== fileIdByTask.get(task.id))) {
      store.update(task.id, { status: "paused", error: "Agent attempted to use an unavailable file" });
      store.addEvent(task.id, "policy.blocked", { actionType: action.type, reason: "file_id_not_attached" });
      return { task: store.get(task.id), action: null, blocked: true, reason: "该文件没有附加到当前任务，上传已阻止。" };
    }
    if (task.mode !== "execute" && !["extract", "wait", "finish"].includes(action.type)) {
      store.update(task.id, { status: "paused", error: `只读模式不能执行 ${action.type}` });
      store.addEvent(task.id, "policy.blocked", { actionType: action.type, mode: task.mode });
      return { task: store.get(task.id), action: null, blocked: true, reason: "当前模式只允许观察页面和生成计划。" };
    }
    const decision = isActionAllowed(action, parsed.data);
    store.addEvent(task.id, "agent.action_proposed", { action, risk: decision.risk, observationSignature });
    if (!decision.allowed) {
      if (decision.risk === "high") {
        store.update(task.id, { status: "waiting_confirmation", pendingAction: action, error: decision.reason });
        return { task: store.get(task.id), action: { ...action, risk: decision.risk, confirmationRequired: true } };
      }
      store.update(task.id, { status: "paused", error: decision.reason });
      return { task: store.get(task.id), action: null, blocked: true, reason: decision.reason };
    }
    if (action.type === "finish") store.update(task.id, { status: "completed", pendingAction: undefined });
    else store.update(task.id, { status: "running", pendingAction: action });
    return { task: store.get(task.id), action };
  } catch (error) {
    const message = error instanceof Error ? error.message : "agent failed";
    store.update(task.id, { status: "failed", error: message });
    fileContextByTask.delete(task.id);
    store.addEvent(task.id, "agent.failed", { message });
    return reply.code(502).send({ error: message });
  }
});

app.post<{ Params: { id: string }; Body: { action: unknown; ok: boolean; result?: unknown; error?: string; pageVersion?: string } }>("/api/tasks/:id/action-result", async (request, reply) => {
  const task = store.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "task not found" });
  const action = browserActionSchema.safeParse(request.body?.action);
  if (!action.success) return reply.code(400).send({ error: "invalid action" });
  const proposalExists = task.events.some((event) => event.kind === "agent.action_proposed" && (event.payload as { action?: { actionId?: string } }).action?.actionId === action.data.actionId);
  const resultExists = task.events.some((event) => event.kind === "browser.action_result" && (event.payload as { action?: { actionId?: string } }).action?.actionId === action.data.actionId);
  const pendingMatches = task.pendingAction?.actionId === action.data.actionId && task.pendingAction.type === action.data.type;
  if ((!pendingMatches && !(task.status === "paused" && proposalExists && !resultExists)) || resultExists) return reply.code(409).send({ error: "action is stale or was already handled" });
  const wasPaused = task.status === "paused";
  if (!request.body.ok) store.update(task.id, { status: "paused", error: request.body.error ?? "browser action failed", pendingAction: undefined });
  else if (action.data.type === "finish") store.update(task.id, { status: "completed", pendingAction: undefined, error: undefined });
  else if (wasPaused) store.update(task.id, { status: "paused", pendingAction: undefined });
  else store.update(task.id, { status: "running", pendingAction: undefined, error: undefined });
  if (!request.body.ok || action.data.type === "finish") { fileContextByTask.delete(task.id); fileIdByTask.delete(task.id); }
  store.addEvent(task.id, "browser.action_result", { action: action.data, ok: request.body.ok, result: request.body.result, error: request.body.error, pageVersion: request.body.pageVersion });
  return { task: store.get(task.id) };
});

app.post<{ Params: { id: string }; Body: { approved: boolean } }>("/api/tasks/:id/confirm", async (request, reply) => {
  const task = store.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "task not found" });
  if (task.status !== "waiting_confirmation" || !task.pendingAction) return reply.code(409).send({ error: "no pending approval" });
  store.addEvent(task.id, "approval.decided", { approved: request.body?.approved === true, actionId: task.pendingAction.actionId });
  if (request.body?.approved !== true) { store.update(task.id, { status: "stopped", pendingAction: undefined, error: "User rejected the action" }); fileContextByTask.delete(task.id); fileIdByTask.delete(task.id); }
  else store.update(task.id, { status: "running" });
  return { task: store.get(task.id), action: request.body?.approved === true ? task.pendingAction : null };
});

app.post<{ Params: { id: string } }>("/api/tasks/:id/stop", async (request, reply) => {
  const task = store.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "task not found" });
  store.update(task.id, { status: "stopped", pendingAction: undefined });
  fileContextByTask.delete(task.id);
  fileIdByTask.delete(task.id);
  store.addEvent(task.id, "task.stopped", {});
  return { task: store.get(task.id) };
});

app.post<{ Params: { id: string } }>("/api/tasks/:id/pause", async (request, reply) => {
  const task = store.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "task not found" });
  if (["completed", "failed", "stopped"].includes(task.status)) return reply.code(409).send({ error: "task cannot be paused" });
  store.update(task.id, { status: "paused", pendingAction: undefined }); store.addEvent(task.id, "task.paused", {});
  return { task: store.get(task.id) };
});

app.post<{ Params: { id: string } }>("/api/tasks/:id/resume", async (request, reply) => {
  const task = store.get(request.params.id);
  if (!task) return reply.code(404).send({ error: "task not found" });
  if (task.status !== "paused") return reply.code(409).send({ error: "task is not paused" });
  store.update(task.id, { status: "running", error: undefined }); store.addEvent(task.id, "task.resumed", {});
  return { task: store.get(task.id) };
});

app.post("/api/protocol/validate", async (request, reply) => {
  const parsed = wireMessageSchema.safeParse(request.body);
  return parsed.success ? { valid: true, message: parsed.data } : reply.code(400).send({ valid: false, error: parsed.error.flatten() });
});

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: "127.0.0.1" });
