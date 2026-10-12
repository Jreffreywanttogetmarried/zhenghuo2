import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Mode = "explore" | "plan" | "execute";
type Task = { id: string; goal: string; mode: Mode; status: string; error?: string; pendingAction?: { type: string; reason?: string; actionId: string; url?: string }; events?: Array<{ kind: string; payload: unknown; at: string }> };
type State = { task?: Task; action?: { type: string; reason?: string; actionId: string; url?: string; risk?: string; confirmationRequired?: boolean }; error?: string };

function App() {
  const [goal, setGoal] = useState(""); const [mode, setMode] = useState<Mode>("execute");
  const [state, setState] = useState<State>({}); const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => {
    const listener = (message: State) => setState(message);
    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({ kind: "get_state" }).then((value) => value && setState(value)).catch(() => undefined);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
  async function start() {
    if (!goal.trim() || busy) return;
    setBusy(true); setState({});
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.url) throw new Error("无法读取当前标签页地址，请切换到一个普通网页后重试。");
      if (/^https?:/i.test(tab.url)) {
        const origin = new URL(tab.url).origin;
        const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
        if (!granted && !await chrome.permissions.request({ origins: [`${origin}/*`] })) throw new Error(`需要允许访问 ${new URL(tab.url).host} 才能操作此页面。`);
      }
      let fileContext: string | undefined;
      if (file) {
        setState({ error: `正在安全解析 ${file.name}…` });
        const form = new FormData(); form.append("file", file, file.name);
        const parsed = await fetch("http://127.0.0.1:8787/api/files/parse", { method: "POST", body: form });
        const payload = await parsed.json();
        if (!parsed.ok) throw new Error(payload.error ?? "文件解析失败");
        fileContext = payload.text;
      }
      setState(await chrome.runtime.sendMessage({ kind: "start_task", goal: goal.trim(), mode, fileContext }));
    }
    catch (error) { setState({ error: error instanceof Error ? error.message : "扩展服务不可用" }); }
    finally { setBusy(false); }
  }
  async function decide(approved: boolean) {
    if (!state.task) return; setBusy(true);
    try {
      const pending = state.action ?? state.task?.pendingAction;
      if (approved && pending?.type === "open_url") {
        const destination = new URL((pending as { url: string }).url!);
        if (!["http:", "https:"].includes(destination.protocol)) throw new Error("只允许打开 HTTP 或 HTTPS 网页。");
        const granted = await chrome.permissions.contains({ origins: [`${destination.origin}/*`] });
        if (!granted && !await chrome.permissions.request({ origins: [`${destination.origin}/*`] })) throw new Error(`需要允许访问 ${destination.host} 才能继续。`);
      }
      setState(await chrome.runtime.sendMessage({ kind: "confirm", taskId: state.task.id, approved }));
    }
    catch (error) { setState({ ...state, error: error instanceof Error ? error.message : "确认失败" }); }
    finally { setBusy(false); }
  }
  async function stop() { if (!state.task) return; setState(await chrome.runtime.sendMessage({ kind: "stop", taskId: state.task.id })); }
  async function togglePause() {
    if (!state.task) return;
    setBusy(true);
    try { setState(await chrome.runtime.sendMessage({ kind: state.task.status === "paused" ? "resume" : "pause", taskId: state.task.id })); }
    catch (error) { setState({ ...state, error: error instanceof Error ? error.message : "任务状态更新失败" }); }
    finally { setBusy(false); }
  }
  const task = state.task; const action = state.action ?? task?.pendingAction;
  const needsApproval = state.action?.confirmationRequired || state.action?.risk === "high";
  return <main>
    <header><div><span className="eyebrow">BROWSER AGENT</span><h1>浏览器助手</h1></div><span className={`status ${task?.status ?? "idle"}`}>{statusLabel(task?.status)}</span></header>
    <section className="composer"><label htmlFor="goal">告诉我你要完成什么</label><textarea id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="例如：打开搜索页面，查找最近的订单并整理结果" disabled={busy}/>
      <div className="row"><select value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={busy}><option value="execute">执行任务</option><option value="plan">只生成计划</option><option value="explore">只读探索</option></select><label className="file"><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)}/><span>{file ? file.name : "选择文件"}</span></label><button onClick={start} disabled={!goal.trim() || busy}>{busy ? "处理中…" : "开始"}</button></div>
      {file && <p className="file-note">{file.name} · {(file.size / 1024).toFixed(1)} KB · 解析内容会作为任务上下文；本版本不会自动提交到网页表单</p>}
    </section>
    {state.error && <div className="alert">{state.error}</div>}
    {needsApproval && action && <section className="approval"><span className="eyebrow">需要确认</span><h2>助手准备执行一项有影响的操作</h2><p>{action.type === "open_url" && action.url ? `导航到：${action.url}` : action.reason ?? `动作：${action.type}`}</p><div className="row"><button className="secondary" onClick={() => decide(false)} disabled={busy}>拒绝</button><button onClick={() => decide(true)} disabled={busy}>允许一次</button></div></section>}
    {task && <section className="timeline"><div className="section-heading"><h2>任务进度</h2><div className="row"><button className="text-button" onClick={togglePause} disabled={["stopped", "completed", "failed", "waiting_confirmation"].includes(task.status)}>{task.status === "paused" ? "继续" : "暂停"}</button><button className="text-button" onClick={stop} disabled={["stopped", "completed", "failed"].includes(task.status)}>停止</button></div></div>
      {(task.events ?? []).slice(-10).map((event, index) => <div className="event" key={`${event.at}-${index}`}><span className="dot"/><div><strong>{eventLabel(event.kind)}</strong><small>{new Date(event.at).toLocaleTimeString()}</small></div></div>)}
      {task.error && <p className="task-error">{task.error}</p>}
    </section>}
    <footer>网页内容按不可信数据处理。密码、验证码和密钥字段不会发送给模型。页面内容会按任务需要发送到云端模型。</footer>
  </main>;
}

function statusLabel(status?: string) { return ({ idle: "就绪", queued: "排队中", running: "运行中", waiting_confirmation: "等待确认", paused: "已暂停", completed: "已完成", failed: "失败", stopped: "已停止" } as Record<string, string>)[status ?? "idle"] ?? status; }
function eventLabel(kind: string) { return ({ "task.created": "任务已创建", "browser.observed": "已读取当前页面", "agent.action_proposed": "助手提出下一步", "browser.action_result": "浏览器返回结果", "approval.decided": "确认已处理", "agent.failed": "任务失败", "task.stopped": "任务已停止" } as Record<string, string>)[kind] ?? kind; }
createRoot(document.getElementById("root")!).render(<App/>);
