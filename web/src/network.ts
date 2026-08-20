export interface NetworkEntry {
  url: string;
  method: string;
  resource_type: string;
  reason: string;
  contains_user_data: boolean;
  allowed: boolean;
}

const observed: NetworkEntry[] = [];
const originalFetch = window.fetch.bind(window);
const originalBeacon = navigator.sendBeacon?.bind(navigator);
const originalXhrOpen = XMLHttpRequest.prototype.open;
const originalXhrSend = XMLHttpRequest.prototype.send;
const xhrRequests = new WeakMap<XMLHttpRequest, { url: URL; method: string; allowed: boolean }>();

function normalizeUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url, location.href);
  return new URL(String(input), location.href);
}

function sameOrigin(url: URL): boolean {
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    const expectedProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    return url.protocol === expectedProtocol && url.host === location.host;
  }
  return url.origin === location.origin;
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = normalizeUrl(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const allowed = sameOrigin(url);
  observed.push({
    url: url.href,
    method,
    resource_type: "fetch",
    reason: allowed ? "应用或 ONNX Runtime 本地静态资源" : "非同源请求已阻止",
    contains_user_data: Boolean(init?.body),
    allowed,
  });
  if (!allowed) throw new Error(`隐私保护：已阻止非同源请求 ${url.href}`);
  return originalFetch(input, init);
};

if (originalBeacon) {
  navigator.sendBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
    const parsed = new URL(String(url), location.href);
    const allowed = sameOrigin(parsed);
    observed.push({
      url: parsed.href,
      method: "POST",
      resource_type: "beacon",
      reason: allowed ? "同源 Beacon" : "非同源 Beacon 已阻止",
      contains_user_data: data != null,
      allowed,
    });
    return allowed ? originalBeacon(url, data) : false;
  };
}

XMLHttpRequest.prototype.open = function guardedOpen(
  method: string,
  url: string | URL,
  async: boolean = true,
  username?: string | null,
  password?: string | null,
): void {
  const parsed = new URL(String(url), location.href);
  const allowed = sameOrigin(parsed);
  xhrRequests.set(this, { url: parsed, method: method.toUpperCase(), allowed });
  if (!allowed) throw new Error(`隐私保护：已阻止非同源 XHR ${parsed.href}`);
  const invoke = originalXhrOpen as (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean,
    username?: string | null,
    password?: string | null,
  ) => void;
  invoke.call(this as XMLHttpRequest, method, url, async, username, password);
};

XMLHttpRequest.prototype.send = function guardedSend(body?: Document | XMLHttpRequestBodyInit | null): void {
  const request = xhrRequests.get(this);
  if (request) {
    observed.push({
      url: request.url.href,
      method: request.method,
      resource_type: "xhr",
      reason: request.allowed ? "同源 XHR" : "非同源 XHR 已阻止",
      contains_user_data: body != null,
      allowed: request.allowed,
    });
  }
  originalXhrSend.call(this, body);
};

const NativeWebSocket = window.WebSocket;
class GuardedWebSocket extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const parsed = new URL(String(url), location.href.replace(/^http/u, "ws"));
    const allowed = sameOrigin(parsed);
    observed.push({
      url: parsed.href,
      method: "CONNECT",
      resource_type: "websocket",
      reason: allowed ? "同源 WebSocket" : "非同源 WebSocket 已阻止",
      contains_user_data: false,
      allowed,
    });
    if (!allowed) throw new Error(`隐私保护：已阻止非同源 WebSocket ${parsed.href}`);
    if (protocols === undefined) super(url);
    else super(url, protocols);
  }
}
window.WebSocket = GuardedWebSocket;

function guardForm(form: HTMLFormElement): boolean {
  const parsed = new URL(form.action || location.href, location.href);
  const allowed = sameOrigin(parsed);
  observed.push({
    url: parsed.href,
    method: (form.method || "GET").toUpperCase(),
    resource_type: "form",
    reason: allowed ? "同源表单" : "非同源表单已阻止",
    contains_user_data: true,
    allowed,
  });
  return allowed;
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (form instanceof HTMLFormElement && !guardForm(form)) event.preventDefault();
}, true);

const nativeFormSubmit = HTMLFormElement.prototype.submit;
HTMLFormElement.prototype.submit = function guardedSubmit(): void {
  if (!guardForm(this)) throw new Error(`隐私保护：已阻止非同源表单 ${this.action}`);
  nativeFormSubmit.call(this);
};

export function networkSummary(): NetworkEntry[] {
  const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  const performanceEntries: NetworkEntry[] = resources.map((entry) => {
    const url = new URL(entry.name, location.href);
    return {
      url: url.href,
      method: "GET",
      resource_type: entry.initiatorType || "resource",
      reason: "浏览器已加载的页面静态资源",
      contains_user_data: false,
      allowed: sameOrigin(url),
    };
  });
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (navigation) {
    performanceEntries.unshift({
      url: location.href,
      method: "GET",
      resource_type: "document",
      reason: "PoC 页面",
      contains_user_data: false,
      allowed: true,
    });
  }

  const unique = new Map<string, NetworkEntry>();
  for (const entry of [...performanceEntries, ...observed]) {
    unique.set(`${entry.method}|${entry.url}|${entry.resource_type}`, entry);
  }
  return [...unique.values()].sort((a, b) => a.url.localeCompare(b.url));
}
