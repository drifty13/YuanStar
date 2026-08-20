import { BrowserVisionWorkerClient } from "../src/structured/browser-vision-worker-client.js";
import type { BrowserVisionWorkerRequest, BrowserVisionWorkerResponse } from "../src/structured/browser-vision-worker-protocol.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class FakeWorker {
  onmessage: ((event: MessageEvent<BrowserVisionWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly requests: BrowserVisionWorkerRequest[] = [];
  terminated = false;

  postMessage(value: BrowserVisionWorkerRequest): void { this.requests.push(value); }
  terminate(): void { this.terminated = true; }

  respond(request: BrowserVisionWorkerRequest, response: Omit<BrowserVisionWorkerResponse, "version" | "requestId" | "operation">): void {
    this.onmessage?.({ data: { version: 1, requestId: request.requestId, operation: request.operation, ...response } } as MessageEvent<BrowserVisionWorkerResponse>);
  }
}

function diagnostics(state: BrowserVisionWorkerResponse["diagnostics"]["state"] = "ready"): BrowserVisionWorkerResponse["diagnostics"] {
  return { executionBackend: "dedicated_worker", state, lastRequest: null, network: { requestCount: 0, externalRequestCount: 0, containsUserDataCount: 0 } };
}

async function expectReject(promise: Promise<unknown>, message: string): Promise<void> {
  try { await promise; } catch { return; }
  throw new Error(message);
}

async function run(): Promise<void> {
  const workers: FakeWorker[] = [];
  const client = new BrowserVisionWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });

  const initializing = client.initialize({});
  const first = workers[0]!;
  assert(first.requests.length === 1 && first.requests[0]?.operation === "initialize", "initialize should send a request");
  const duplicateInitialize = client.initialize({});
  assert(first.requests.length === 1, "duplicate initialize should share the pending request");
  first.respond(first.requests[0]!, { ok: true, result: { schemaVersion: "1.0", models: [] }, diagnostics: diagnostics() });
  assert((await initializing).models.length === 0 && (await duplicateInitialize).models.length === 0, "initialize response should resolve both callers");

  const classify = client.classifyImage({ imageId: "image-1", file: {} as File });
  const classifyRequest = first.requests[1]!;
  first.respond({ ...classifyRequest, requestId: "unmatched" }, { ok: true, result: null, diagnostics: diagnostics() });
  first.respond(classifyRequest, { ok: true, result: { pageType: "unknown", visualEvidence: [], tabOcrEvidence: [], confidence: 0, warning: null, reviewRequired: true }, diagnostics: diagnostics() });
  assert((await classify).pageType === "unknown", "classify response should match by request id");

  const analyzed = client.analyzeImage({ imageId: "image-1", file: {} as File });
  const analyzeRequest = first.requests[2]!;
  first.respond(analyzeRequest, { ok: false, error: { code: "worker_operation_failed", message: "structured failure" }, diagnostics: diagnostics("failed") });
  await expectReject(analyzed, "structured worker errors should reject");

  const pending = client.classifyImage({ imageId: "image-2", file: {} as File });
  first.onerror?.({} as ErrorEvent);
  await expectReject(pending, "worker fatal errors should reject pending work");
  assert(client.state === "failed" && first.terminated, "fatal worker error should fail and terminate the client worker");

  const reinitialized = client.initialize({});
  const second = workers[1]!;
  second.respond(second.requests[0]!, { ok: true, result: { schemaVersion: "1.0", models: [] }, diagnostics: diagnostics() });
  await reinitialized;
  const disposing = client.dispose();
  const disposeRequest = second.requests[1]!;
  assert(disposeRequest.operation === "dispose", "dispose should be sent to the worker");
  second.respond(disposeRequest, { ok: true, result: null, diagnostics: diagnostics("disposed") });
  await disposing;
  await expectReject(client.classifyImage({ imageId: "image-3", file: {} as File }), "dispose should prohibit analysis");

  const afterDispose = client.initialize({});
  const third = workers[2]!;
  third.respond(third.requests[0]!, { ok: true, result: { schemaVersion: "1.0", models: [] }, diagnostics: diagnostics() });
  await afterDispose;
  assert(String(client.state) === "ready", "explicit initialize should create a fresh worker after dispose");
}

void run();
