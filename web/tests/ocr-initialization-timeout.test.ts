import { BrowserVisionWorkerClient, WORKER_INITIALIZATION_TIMEOUT_MS } from "../src/structured/browser-vision-worker-client.js";
import { BrowserOcrRuntime } from "../src/ocr/browser-ocr-runtime.js";
import { startProductOcrLifecycle } from "../src/product-ocr-lifecycle.js";
import type { BrowserOcrRuntimeJobV1 } from "../src/ocr/browser-analysis-contract.js";
import type { BrowserImageAnalysisV1 } from "../src/structured/contracts.js";
import type { BrowserVisionWorkerRequest, BrowserVisionWorkerResponse } from "../src/structured/browser-vision-worker-protocol.js";

let checks = 0;
function expect(value: unknown, message: string): void { checks++; if (!value) throw new Error(message); }
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const timers = new Map<number, { callback: () => void; delay: number | undefined }>();
const cleared: number[] = [];
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
let timerId = 0;
globalThis.setTimeout = ((callback: () => void, delay?: number) => { timers.set(++timerId, { callback, delay }); return timerId; }) as typeof setTimeout;
globalThis.clearTimeout = ((id: number) => { cleared.push(id); timers.delete(id); }) as typeof clearTimeout;

class FakeWorker {
  onmessage: ((event: MessageEvent<BrowserVisionWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: BrowserVisionWorkerRequest[] = [];
  terminations = 0;
  postMessage(request: BrowserVisionWorkerRequest) { this.requests.push(request); }
  terminate() { this.terminations++; }
  respond(request = this.requests[0]!, result: BrowserVisionWorkerResponse["result"] = { schemaVersion: "1.0", models: [] }) {
    this.onmessage?.({ data: { version: 1, requestId: request.requestId, operation: request.operation, ok: true, result,
      diagnostics: { executionBackend: "dedicated_worker", state: "ready", lastRequest: null, network: { requestCount: 0, externalRequestCount: 0, containsUserDataCount: 0 } } } } as MessageEvent<BrowserVisionWorkerResponse>);
  }
}
function workers() {
  const all: FakeWorker[] = [];
  const client = new BrowserVisionWorkerClient(() => { const worker = new FakeWorker(); all.push(worker); return worker as unknown as Worker; });
  return { client, all };
}
function errorOf(promise: Promise<unknown>) { return promise.then(() => null, (error: unknown) => error); }
function fireTimer() {
  expect(timers.size === 1, "one shared initialization owns exactly one timer");
  const [id, timer] = [...timers][0]!;
  expect(timer.delay === 300_000 && timer.delay === WORKER_INITIALIZATION_TIMEOUT_MS, "timeout is exactly 300 seconds");
  timer.callback();
  expect(!timers.has(id) && cleared.includes(id), "timeout callback clears its timer immediately");
  return timer.callback;
}
function job(id: string): BrowserOcrRuntimeJobV1 {
  return { schemaVersion: 1, jobId: id, images: [{ sourceImageId: "synthetic", sourceOrder: 0, file: {} as File, confirmedPool: { imageId: "synthetic", pageType: "main" } }] };
}
function emptyAnalysis(): BrowserImageAnalysisV1 {
  const unknown = { value: null, status: "unreadable" as const, confidence: 0, rawText: "", normalizedText: "", evidence: [], reviewReasonCodes: [] };
  return { schemaVersion: "1.0", imageId: "synthetic", pageClassification: { pageType: "main", confidence: 1, reviewRequired: false, warning: null, visualEvidence: [], tabOcrEvidence: [] },
    profileAndBounds: { profile: {} as BrowserImageAnalysisV1["profileAndBounds"]["profile"], contentBounds: null, contentBoundsSource: "fixture", warnings: [] },
    occurrences: [], experienceOccurrences: [], experienceAggregate: null, warnings: [],
    inventoryHeader: { roi: { x: 0, y: 0, width: 1, height: 1 }, tokens: [], currentCount: unknown, capacity: unknown },
    timings: { decodeMs: 0, profileContentBoundsMs: 0, geometryCompletenessMs: 0, roiCropMs: 0, nameRecognitionMs: 0, levelRecognitionMs: 0, qualityRecognitionMs: 0, equippedRecognitionMs: 0, tabOcrMs: 0, postprocessMs: 0, totalMs: 1, peakCandidateCount: 0, ocrSessionCreationCount: 1, ocrRecognitionCallCount: 0 } };
}
try {
  const shared = workers();
  const first = errorOf(shared.client.initialize({})), joined = errorOf(shared.client.initialize({}));
  expect(shared.all[0]!.requests.length === 1, "joined worker callers share request");
  const staleTimeout = fireTimer();
  const [e1, e2] = await Promise.all([first, joined]);
  expect(e1 === e2 && e1 instanceof Error && "code" in e1 && e1.code === "worker_initialization_timeout", "joined callers receive the same timeout error");
  expect(shared.client.state === "failed" && shared.all[0]!.terminations === 1, "timeout fails and terminates worker once");
  expect(shared.all.length === 1 && shared.all[0]!.requests.length === 1, "timeout starts neither analysis nor automatic retry");
  const retry = shared.client.initialize({});
  expect(shared.all.length === 2 && timers.size === 1, "explicit worker retry initializes fresh worker/timer");
  shared.all[0]!.respond(); shared.all[0]!.onerror?.(); staleTimeout();
  expect(shared.client.state === "initializing" && shared.all[1]!.terminations === 0, "old messages/errors/timer cannot revive old state or fail fresh worker");
  shared.all[1]!.respond(); await retry;
  expect(String(shared.client.state) === "ready" && timers.size === 0, "successful initialization clears timer");
  const disposeReady = shared.client.dispose(); shared.all[1]!.respond(shared.all[1]!.requests[1]!, null); await disposeReady;

  // Force callbacks even after clearTimeout to exercise disposal vs queued timeout races.
  const disposed = workers();
  const initDisposed = errorOf(disposed.client.initialize({}));
  const queued = [...timers.values()][0]!.callback;
  await disposed.client.dispose(); queued(); disposed.all[0]!.respond();
  await initDisposed;
  expect(disposed.client.state === "disposed" && disposed.all[0]!.terminations === 1 && timers.size === 0, "dispose is immediate and late timeout/response cannot revive it");

  const fatal = workers(), fatalInit = errorOf(fatal.client.initialize({}));
  fatal.all[0]!.onerror?.(); await fatalInit;
  expect(fatal.client.state === "failed" && fatal.all[0]!.terminations === 1 && timers.size === 0, "initialization fatal error also clears timer and releases worker");

  const direct = workers(), directRuntime = new BrowserOcrRuntime({ createEngine: () => direct.client });
  const directRun = directRuntime.run(job("direct-timeout")); await tick(); fireTimer();
  expect((await directRun).error?.code === "engine_initialization_timeout", "formal run without background preparation exposes the same timeout");
  expect(direct.all[0]!.terminations === 1 && direct.all[0]!.requests.length === 1 && timers.size === 0, "direct timeout terminates once without analysis");
  await directRuntime.dispose();

  const runtimeWorkers: FakeWorker[] = [], clients: BrowserVisionWorkerClient[] = [];
  const runtime = new BrowserOcrRuntime({ createEngine: () => {
    const client = new BrowserVisionWorkerClient(() => { const worker = new FakeWorker(); runtimeWorkers.push(worker); return worker as unknown as Worker; }); clients.push(client); return client;
  } });
  const preparation = runtime.prepare(), secondPreparation = runtime.prepare();
  expect(preparation === secondPreparation, "runtime preparation callers share identical Promise");
  const preparationError = errorOf(preparation), joinedError = errorOf(secondPreparation);
  const run = runtime.run(job("joins-timeout")); await tick(); fireTimer();
  const result = await run;
  expect(await preparationError === await joinedError, "background callers share timeout result");
  expect(result.status === "failed" && result.error?.code === "engine_initialization_timeout" && result.error.retryable, "run exposes typed retryable initialization timeout contract");
  expect(result.result === null && runtime.state === "failed" && clients.length === 1, "joined timeout does not start a second initialization");
  expect(runtimeWorkers[0]!.terminations === 1 && runtimeWorkers[0]!.requests.length === 1 && clients[0]!.state === "disposed", "runtime releases initialization state without analyzing");
  runtimeWorkers[0]!.respond(); await tick();
  expect(runtime.state === "failed", "late initialization completion cannot restore runtime");
  const next = runtime.run(job("explicit-retry")); await tick();
  expect(clients.length === 2, "genuinely new run creates a fresh engine");
  runtimeWorkers[1]!.respond(); await tick();
  expect(runtimeWorkers[1]!.requests[1]?.operation === "analyzeImage", "only successful explicit retry begins analysis");
  runtimeWorkers[1]!.respond(runtimeWorkers[1]!.requests[1]!, emptyAnalysis());
  await tick();
  expect(runtimeWorkers[1]!.requests.length === 2, `retry must not issue unexpected operations: ${runtimeWorkers[1]!.requests.map((r) => r.operation)}`);
  for (const [id, timer] of timers) {
    expect(timer.delay === 0, "successful retry has only the existing batch event-loop yield left");
    timers.delete(id); timer.callback();
  }
  expect((await next).status === "completed" && timers.size === 0, "explicit retry completes with cleared timer");
  const stopReady = runtime.dispose(); runtimeWorkers[1]!.respond(runtimeWorkers[1]!.requests[2]!, null); await stopReady;

  for (const action of ["cancel", "dispose", "timeout-then-cancel", "timeout-then-dispose"] as const) {
    const f = workers(), r = new BrowserOcrRuntime({ createEngine: () => f.client });
    const pending = r.run(job(action)); await tick();
    const queuedTimer = [...timers.values()][0]!.callback;
    if (action.startsWith("timeout-then")) fireTimer();
    if (action.endsWith("dispose")) {
      const stop = r.dispose(); expect(r.dispose() === stop, "runtime reuses disposal Promise"); await stop;
    } else { expect(r.cancel(), "cancel interrupts formal initialization"); }
    queuedTimer(); f.all[0]!.respond();
    expect((await pending).status === "cancelled", "cancellation/disposal wins timeout race without stale failure");
    await r.dispose();
    expect(f.all[0]!.terminations === 1 && f.all[0]!.requests.length === 1 && timers.size === 0, "race has one cleanup path, zero analysis, zero residual timer");
    expect(r.state === "disposed", "late completion cannot overwrite disposed runtime");
  }

  const pageWorker = workers(), pageRuntime = new BrowserOcrRuntime({ createEngine: () => pageWorker.client });
  const frames: FrameRequestCallback[] = [];
  let hide!: () => void;
  startProductOcrLifecycle(pageRuntime, { requestAnimationFrame: (callback) => frames.push(callback), cancelAnimationFrame: () => { frames.length = 0; }, addEventListener: (_type, listener) => { hide = listener; } });
  frames.shift()!(0); frames.shift()!(0); await tick();
  expect(timers.size === 1, "page lifecycle starts timed preparation after paint");
  const afterExit = [...timers.values()][0]!.callback;
  hide(); await tick(); afterExit(); pageWorker.all[0]!.respond(); await tick();
  expect(pageRuntime.state === "disposed" && pageWorker.all[0]!.terminations === 1 && timers.size === 0, "pagehide releases initialization worker/timer and rejects late completion");
  expect(frames.length === 0, "pagehide removes pending lifecycle frames");
  console.log(`OCR initialization timeout: ${checks} checks passed`);
} finally {
  globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear;
}
