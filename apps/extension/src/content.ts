import { browserActionSchema, type BrowserAction, type PageObservation } from "@browser-agent/protocol";

let refMap = new Map<string, Element>();
let pageVersion = crypto.randomUUID();
let refreshTimer: number | undefined;
const extensionScope = globalThis as typeof globalThis & { __browserAgentContentInstalled?: boolean };
if (extensionScope.__browserAgentContentInstalled) throw new Error("Browser Agent content script already installed");
extensionScope.__browserAgentContentInstalled = true;

const mutationObserver = new MutationObserver(() => {
  pageVersion = crypto.randomUUID();
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    void chrome.runtime.sendMessage({ kind: "page_changed", observation: observePage() }).catch(() => undefined);
  }, 500);
});
mutationObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.kind === "observe") { sendResponse({ ok: true, observation: observePage() }); return; }
  if (message.kind === "execute") {
    void execute(message.action).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Action failed", pageVersion }));
    return true;
  }
});

function observePage(): PageObservation {
  refMap = new Map();
  const candidates = Array.from(document.querySelectorAll("button,a,input,textarea,select,[role],[contenteditable='true']")).slice(0, 500);
  const elements = candidates.map((element, index) => {
    const ref = `e${index + 1}`;
    refMap.set(ref, element);
    const html = element as HTMLElement;
    const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element : undefined;
    const type = input instanceof HTMLInputElement ? input.type.toLowerCase() : undefined;
    const labelText = input?.labels ? Array.from(input.labels).map((label) => label.innerText).join(" ") : "";
    const name = clean([element.getAttribute("aria-label"), element.getAttribute("title"), labelText, input?.getAttribute("placeholder"), element.getAttribute("name"), html.innerText].find((value) => value?.trim()) ?? element.tagName.toLowerCase()).slice(0, 500);
    const rect = html.getBoundingClientRect();
    const style = getComputedStyle(html);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    const role = element.getAttribute("role") ?? implicitRole(element);
    let linkInfo: { hrefOrigin?: string; hrefProtocol?: "http:" | "https:" | "unsafe" } = {};
    if (element instanceof HTMLAnchorElement) {
      try {
        const target = new URL(element.href);
        const hrefProtocol = target.protocol === "http:" || target.protocol === "https:" ? target.protocol : "unsafe";
        linkInfo = { hrefProtocol, ...(hrefProtocol === "unsafe" ? {} : { hrefOrigin: target.origin }) };
      } catch { linkInfo = { hrefProtocol: "unsafe" }; }
    }
    return { ref, role, name, text: clean(html.innerText ?? "").slice(0, 2_000), visible, disabled: "disabled" in element ? Boolean((element as HTMLButtonElement).disabled) : element.getAttribute("aria-disabled") === "true", ...(type ? { inputType: type } : {}), ...linkInfo };
  });
  const text = clean(document.body?.innerText ?? "").slice(0, 30_000);
  // The model only needs the origin for cross-site risk checks. Do not send
  // query strings or fragments, which may contain session tokens or secrets.
  return { pageVersion, url: location.origin, title: document.title.slice(0, 500), elements, text };
}

async function execute(raw: unknown) {
  if (!isBrowserAction(raw)) return { ok: false, error: "Invalid browser action", pageVersion };
  const action: BrowserAction = raw;
  if (action.expectedPageVersion && action.expectedPageVersion !== pageVersion) return { ok: false, error: "Page changed; action reference expired", pageVersion };
  const element = "ref" in action ? refMap.get(action.ref) : undefined;
  if ("ref" in action && !element) return { ok: false, error: "Element reference expired. Observe the page again.", pageVersion };
  if (element && !(element as HTMLElement).isConnected) return { ok: false, error: "Element is no longer on the page", pageVersion };
  switch (action.type) {
    case "open_url": {
      const url = new URL(action.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are allowed");
      location.assign(url.href); return { ok: true, result: { navigating: url.href }, pageVersion };
    }
    case "click": {
      const target = element as HTMLElement;
      if (target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") throw new Error("Element is disabled");
      target.scrollIntoView({ block: "center", inline: "center" }); target.click(); return { ok: true, result: { clicked: action.ref }, pageVersion };
    }
    case "type": {
      if (action.sensitive || element instanceof HTMLInputElement && ["password", "email", "tel"].includes(element.type)) throw new Error("Sensitive input must be completed manually");
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable)) throw new Error("Target is not an editable field");
      setValue(element, action.text); return { ok: true, result: { typed: true }, pageVersion };
    }
    case "select": {
      if (!(element instanceof HTMLSelectElement)) throw new Error("Target is not a select field");
      element.value = action.value; element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, result: { selected: true }, pageVersion };
    }
    case "press_key": {
      const target = element instanceof HTMLElement ? element : document.activeElement;
      if (!(target instanceof HTMLElement)) throw new Error("No active element");
      target.dispatchEvent(new KeyboardEvent("keydown", { key: action.key, bubbles: true })); target.dispatchEvent(new KeyboardEvent("keyup", { key: action.key, bubbles: true }));
      return { ok: true, result: { key: action.key }, pageVersion };
    }
    case "scroll": window.scrollBy({ top: action.direction === "down" ? action.amount : -action.amount, behavior: "smooth" }); return { ok: true, result: { scrolled: action.direction }, pageVersion };
    case "wait": await new Promise((resolve) => window.setTimeout(resolve, action.milliseconds)); return { ok: true, result: { waited: action.milliseconds }, pageVersion };
    case "extract": return { ok: true, result: { values: action.refs.map((ref) => ({ ref, text: clean(refMap.get(ref)?.textContent ?? "").slice(0, 5_000) })) }, pageVersion };
    case "upload_file": throw new Error("Automatic upload into website file inputs is not enabled in this MVP");
    case "request_confirmation": return { ok: false, error: "Confirmation actions must be approved through the extension panel", pageVersion };
    case "finish": return { ok: true, result: { summary: action.summary }, pageVersion };
  }
}

function isBrowserAction(value: unknown): value is BrowserAction {
  return browserActionSchema.safeParse(value).success;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLElement, value: string) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, value);
  } else element.textContent = value;
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function implicitRole(element: Element) {
  if (element instanceof HTMLButtonElement) return "button";
  if (element instanceof HTMLAnchorElement) return "link";
  if (element instanceof HTMLInputElement) return element.type === "checkbox" ? "checkbox" : element.type === "radio" ? "radio" : "textbox";
  if (element instanceof HTMLTextAreaElement) return "textbox";
  if (element instanceof HTMLSelectElement) return "combobox";
  return element.tagName.toLowerCase();
}

function clean(value: string) {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").replace(/\b(?:\d[ -]*?){13,19}\b/g, "[number redacted]").replace(/\s+/g, " ").trim();
}
