import type { WorkerNetworkDiagnostics } from "./browser-vision-worker-protocol.js";

const originalFetch = self.fetch.bind(self);
let requestCount = 0;
let externalRequestCount = 0;
let containsUserDataCount = 0;

function toUrl(input: RequestInfo | URL): URL {
  return input instanceof Request ? new URL(input.url, self.location.href) : new URL(String(input), self.location.href);
}

self.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = toUrl(input);
  const allowed = url.origin === self.location.origin;
  requestCount += 1;
  if (init?.body != null || (input instanceof Request && input.body != null)) containsUserDataCount += 1;
  if (!allowed) {
    externalRequestCount += 1;
    throw new Error(`worker_network_blocked: ${url.origin}`);
  }
  return originalFetch(input, init);
};

export function workerNetworkDiagnostics(): WorkerNetworkDiagnostics {
  return { requestCount, externalRequestCount, containsUserDataCount };
}
