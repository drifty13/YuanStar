import type {
  BrowserImageAnalysisV1,
  BrowserImageInput,
  ConfirmedImagePool,
  ModelManifest,
  PageClassificationV1,
  PageType,
  VisionAssetConfig,
} from "./contracts.js";

export type BrowserVisionWorkerOperation = "initialize" | "classifyImage" | "analyzeImage" | "dispose";

export interface WorkerNetworkDiagnostics {
  requestCount: number;
  externalRequestCount: number;
  containsUserDataCount: number;
}

export interface BrowserVisionWorkerDiagnostics {
  executionBackend: "dedicated_worker";
  state: "idle" | "initializing" | "ready" | "disposed" | "failed";
  lastRequest: BrowserVisionWorkerOperation | null;
  network: WorkerNetworkDiagnostics;
}

export type BrowserVisionWorkerRequest =
  | { version: 1; requestId: string; operation: "initialize"; config: VisionAssetConfig }
  | { version: 1; requestId: string; operation: "classifyImage"; input: BrowserImageInput; options?: { confirmedPool?: ConfirmedImagePool } }
  | { version: 1; requestId: string; operation: "analyzeImage"; input: BrowserImageInput; options?: { confirmedPool?: ConfirmedImagePool; expectedPageType?: PageType } }
  | { version: 1; requestId: string; operation: "dispose" };

export type BrowserVisionWorkerSuccess = ModelManifest | PageClassificationV1 | BrowserImageAnalysisV1 | null;

export interface BrowserVisionWorkerError {
  code: "worker_runtime_unavailable" | "worker_operation_failed" | "worker_protocol_error";
  message: string;
}

export interface BrowserVisionWorkerResponse {
  version: 1;
  requestId: string;
  operation: BrowserVisionWorkerOperation;
  ok: boolean;
  result?: BrowserVisionWorkerSuccess;
  error?: BrowserVisionWorkerError;
  diagnostics: BrowserVisionWorkerDiagnostics;
}
