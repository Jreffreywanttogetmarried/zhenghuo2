import { isActionAllowed, observationSchema, type BrowserAction, type PageObservation } from "@browser-agent/protocol";
import { canInjectContentScript, createNavigationOnlyObservation } from "./page-context.js";

const API = "http://127.0.0.1:8787";
type ActiveTask = { taskId: string; tabId: number; action?: BrowserAction; observation?: PageObservation; paused?: boolean };
let active: ActiveTask | undefined;
let requesting = false;

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
});
chrome.commands.onCommand.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (active?.tabId !== tabId) return;
  const taskId = active.taskId;
  active.paused = true;
  void fetch(`${API}/api/tasks/${taskId}/pause`, { method: "POST" }).catch(() => undefined);
  void chrome.storage.local.set({ activeTaskId: taskId, activeTaskTabId: null });
  active = undefined;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handle(message, sender.tab?.id).then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Request failed" }));
  return true;
});

async function handle(message: any, senderTabId?: number): Promise<any> {
  if (message.kind === "get_state") {
    if (!active) await restoreActiveTask();
    return active ? fetchTask(active.taskId) : {};
  }
  if (message.kind === "start_task") return startTask(message.goal, message.mode, message.fileContext);
  if (message.kind === "confirm") return confirmAction(message.taskId, message.approved);
  if (message.kind === "stop") return stopTask(message.taskId);
  if (message.kind === "pause") return pauseTask(message.taskId);
  if (message.kind === "resume") return resumeTask(message.taskId);
  if (message.kind === "page_changed" && active && senderTabId === active.tabId) {
    active.observation = message.observation;
    if (!active.action) return requestNextAction();
  }
  return {};
}

async function startTask(goal: string, mode: "explore" | "plan" | "execute", fileContext?: string) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url) throw new Error("无法读取当前标签页地址，请切换到一个普通网页后重试。");
  const canObservePage = canInjectContentScript(tab.url);
  if (canObservePage) {
    const origin = new URL(tab.url).origin;
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (!granted) throw new Error(`请先允许扩展访问 ${new URL(tab.url).host}，然后重试。`);
  }
  const response = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal, mode, ...(fileContext ? { fileContext } : {}) }),
  });
  if (!response.ok) throw new Error(`无法创建任务：${response.status}`);
  const { task } = await response.json();
  active = { taskId: task.id, tabId: tab.id };
  await chrome.storage.local.set({ activeTaskId: task.id, activeTaskTabId: tab.id });
  let initial: { observation: PageObservation };
  if (!canObservePage) {
    initial = { observation: createNavigationOnlyObservation(tab.url, tab.title ?? "浏览器页面") };
  } else {
    try {
      initial = await chrome.tabs.sendMessage(tab.id, { kind: "observe" });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      initial = await chrome.tabs.sendMessage(tab.id, { kind: "observe" });
    }
  }
  active.observation = initial.observation;
  void requestNextAction();
  return { task };
}

async function requestNextAction() {
  if (!active?.observation || active.paused || requesting) return {};
  requesting = true;
  const validated = observationSchema.safeParse(active.observation);
  if (!validated.success) { requesting = false; throw new Error("页面观察数据无效，请刷新网页后重试。"); }
  try {
    const response = await fetch(`${API}/api/tasks/${active.taskId}/observe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation: validated.data }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Agent 请求失败");
    if (active.paused) return result;
    broadcast(result);
    if (result.action?.confirmationRequired) { active.action = result.action; return result; }
    if (result.action) await execute(result.action);
    return result;
  } catch (error) {
    broadcast({ error: error instanceof Error ? error.message : "Agent 请求失败" });
    return { error: error instanceof Error ? error.message : "Agent 请求失败" };
  } finally { requesting = false; }
}

async function execute(action: BrowserAction, confirmed = false) {
  if (!active || active.paused) return;
  if (action.expectedPageVersion && action.expectedPageVersion !== active.observation?.pageVersion) throw new Error("页面已变化，已阻止过期动作。");
  if (!action.expectedPageVersion && active.observation) action.expectedPageVersion = active.observation.pageVersion;
  const decision = isActionAllowed(action, active.observation);
  if (!decision.allowed && !(confirmed && decision.risk === "high")) { broadcast({ error: decision.reason }); return; }
  active.action = action;
  if (action.type === "open_url") {
    try {
      const tabId = action.newTab
        ? (await chrome.tabs.create({ active: true })).id
        : active.tabId;
      if (tabId === undefined) throw new Error("无法创建目标标签页");
      active.tabId = tabId;
      await chrome.storage.local.set({ activeTaskTabId: tabId });
      const loaded = waitForTabLoad(tabId, action.timeoutMs);
      await chrome.tabs.update(tabId, { url: action.url });
      await loaded;
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      const fresh = await chrome.tabs.sendMessage(tabId, { kind: "observe" });
      active.observation = fresh.observation;
      await postActionResult(action, true, { navigated: new URL(action.url).origin });
      active.action = undefined;
      void requestNextAction();
    } catch (error) {
      active.action = undefined;
      const text = error instanceof Error ? error.message : "Navigation failed";
      await postActionResult(action, false, undefined, text);
      broadcast({ error: `无法打开页面：${text}` });
    }
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(active.tabId, { kind: "execute", action });
    await postActionResult(action, Boolean(result?.ok), result?.result, result?.error, result?.pageVersion);
    active.action = undefined;
    if (result?.ok) {
      if (action.type === "finish") { broadcast(await fetchTask(active.taskId)); return; }
      if (active.paused) return;
      const fresh = await chrome.tabs.sendMessage(active.tabId, { kind: "observe" });
      active.observation = fresh.observation;
      void requestNextAction();
    } else broadcast({ error: result?.error ?? "浏览器动作失败" });
  } catch (error) {
    const text = error instanceof Error ? error.message : "Content script unavailable";
    broadcast({ error: `无法执行：${text}` });
  }
}

async function postActionResult(action: BrowserAction, ok: boolean, result?: unknown, error?: string, pageVersion?: string) {
  if (!active) return;
  await fetch(`${API}/api/tasks/${active.taskId}/action-result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ok, result, error, pageVersion }) });
}

function waitForTabLoad(tabId: number, timeoutMs = 30_000) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); reject(new Error("Navigation timed out")); }, Math.min(timeoutMs, 30_000));
    const onUpdated = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(onUpdated); resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function confirmAction(taskId: string, approved: boolean) {
  if (!active || active.taskId !== taskId || !active.action) return { error: "没有待确认动作" };
  const response = await fetch(`${API}/api/tasks/${taskId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  const action = active.action;
  active.action = undefined;
  if (approved && action.type === "request_confirmation") void requestNextAction();
  else if (approved) await execute(action, true);
  broadcast(result);
  return result;
}

async function stopTask(taskId: string) {
  const response = await fetch(`${API}/api/tasks/${taskId}/stop`, { method: "POST" });
  const result = await response.json();
  if (active?.taskId === taskId) active = undefined;
  broadcast(result); return result;
}

async function pauseTask(taskId: string) {
  const response = await fetch(`${API}/api/tasks/${taskId}/pause`, { method: "POST" });
  const result = await response.json(); if (!response.ok) throw new Error(result.error);
  if (active?.taskId === taskId) { active.paused = true; active.action = undefined; }
  broadcast(result); return result;
}

async function resumeTask(taskId: string) {
  const response = await fetch(`${API}/api/tasks/${taskId}/resume`, { method: "POST" });
  const result = await response.json(); if (!response.ok) throw new Error(result.error);
  if (!active || active.taskId !== taskId) await restoreActiveTask();
  if (active?.taskId === taskId) {
    active.paused = false;
    try { const fresh = await chrome.tabs.sendMessage(active.tabId, { kind: "observe" }); active.observation = fresh.observation; void requestNextAction(); }
    catch { broadcast({ error: "浏览器页面未连接，请刷新页面后重试。" }); }
  }
  broadcast(result); return result;
}

async function fetchTask(taskId: string) {
  const response = await fetch(`${API}/api/tasks/${taskId}`);
  return response.ok ? await response.json() : {};
}

async function restoreActiveTask() {
  const { activeTaskId, activeTaskTabId } = await chrome.storage.local.get(["activeTaskId", "activeTaskTabId"]);
  if (!activeTaskId) return;
  const response = await fetch(`${API}/api/tasks/${activeTaskId}`);
  if (!response.ok) { await chrome.storage.local.remove("activeTaskId"); return; }
  const { task } = await response.json();
  if (["completed", "failed", "stopped"].includes(task.status)) return;
  let tab: chrome.tabs.Tab | undefined;
  if (typeof activeTaskTabId === "number") tab = await chrome.tabs.get(activeTaskTabId).catch(() => undefined);
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  await chrome.storage.local.set({ activeTaskTabId: tab.id });
  active = { taskId: task.id, tabId: tab.id, observation: task.observation, paused: task.status === "paused" };
  try {
    const current = await chrome.tabs.sendMessage(tab.id, { kind: "observe" });
    active.observation = current.observation;
    if (task.pendingAction?.actionId) active.action = task.pendingAction;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      const current = await chrome.tabs.sendMessage(tab.id, { kind: "observe" });
      active.observation = current.observation;
      if (task.pendingAction?.actionId) active.action = task.pendingAction;
    } catch { active = undefined; }
  }
}

function broadcast(message: unknown) {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}
