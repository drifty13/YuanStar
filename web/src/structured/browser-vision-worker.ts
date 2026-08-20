import "./worker-network-guard.js";
import { BrowserVisionEngineRuntime } from "./browser-vision-engine.js";
import type { BrowserVisionWorkerDiagnostics, BrowserVisionWorkerRequest, BrowserVisionWorkerResponse } from "./browser-vision-worker-protocol.js";
import { workerNetworkDiagnostics } from "./worker-network-guard.js";

let runtime = new BrowserVisionEngineRuntime();
let state: BrowserVisionWorkerDiagnostics["state"] = "idle";
let lastRequest: BrowserVisionWorkerDiagnostics["lastRequest"] = null;

function diagnostics(): BrowserVisionWorkerDiagnostics {
  return { executionBackend: "dedicated_worker", state, lastRequest, network: workerNetworkDiagnostics() };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function execute(request: BrowserVisionWorkerRequest): Promise<BrowserVisionWorkerResponse> {
  lastRequest = request.operation;
  try {
    switch (request.operation) {
      case "initialize": {
        if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
          throw new Error("worker_runtime_unavailable: OffscreenCanvas and createImageBitmap are required");
        }
        state = "initializing";
        const result = await runtime.initialize(request.config);
        state = "ready";
        return { version: 1, requestId: request.requestId, operation: request.operation, ok: true, result, diagnostics: diagnostics() };
      }
      case "classifyImage": {
        if (state !== "ready") throw new Error("worker_runtime_unavailable: worker is not ready");
        const result = await runtime.classifyImage(request.input, request.options);
        return { version: 1, requestId: request.requestId, operation: request.operation, ok: true, result, diagnostics: diagnostics() };
      }
      case "analyzeImage": {
        if (state !== "ready") throw new Error("worker_runtime_unavailable: worker is not ready");
        const result = await runtime.analyzeImage(request.input, request.options);
        return { version: 1, requestId: request.requestId, operation: request.operation, ok: true, result, diagnostics: diagnostics() };
      }
      case "dispose": {
        await runtime.dispose();
        state = "disposed";
        return { version: 1, requestId: request.requestId, operation: request.operation, ok: true, result: null, diagnostics: diagnostics() };
      }
    }
  } catch (error) {
    if (request.operation === "initialize") state = "failed";
    return {
      version: 1,
      requestId: request.requestId,
      operation: request.operation,
      ok: false,
      error: { code: message(error).startsWith("worker_runtime_unavailable") ? "worker_runtime_unavailable" : "worker_operation_failed", message: message(error) },
      diagnostics: diagnostics(),
    };
  }
}

self.addEventListener("message", (event: MessageEvent<BrowserVisionWorkerRequest>) => {
  void execute(event.data).then((response) => self.postMessage(response));
});
