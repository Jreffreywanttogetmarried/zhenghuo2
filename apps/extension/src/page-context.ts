import type { PageObservation } from "@browser-agent/protocol";

export function canInjectContentScript(url: string) {
  return /^https?:\/\//i.test(url);
}

export function createNavigationOnlyObservation(url: string, title: string): PageObservation {
  return {
    pageVersion: crypto.randomUUID(),
    url,
    title: title.slice(0, 500),
    elements: [],
    text: "这是浏览器内部页面，扩展无法读取其中的内容。可以根据用户目标打开一个 HTTP 或 HTTPS 网站；打开后才能读取和操作网页。",
  };
}
