export interface OcrBox {
  x: number;
  y: number;
  width: number;
  height: number;
  detectionConfidence: number;
}

export interface OcrLine {
  text: string;
  confidence: number;
  box: OcrBox;
}

export interface Timings {
  decodeMs: number;
  preprocessMs: number;
  detectionInferenceMs: number;
  detectionPostprocessMs: number;
  recognitionInferenceMs: number;
  recognitionPostprocessMs: number;
  totalMs: number;
}

export interface RawOcrResult {
  engine: string;
  scope: string;
  lines: OcrLine[];
}

export interface StoredOcrRecord {
  id: string;
  created_at: string;
  image_name: string;
  image_blob: Blob;
  image_width: number;
  image_height: number;
  raw_ocr_result: RawOcrResult;
  timings: Timings;
  schema_version: 1;
}

export interface BackupRecord extends Omit<StoredOcrRecord, "image_blob"> {
  image_data_url: string;
  image_mime_type: string;
}

export interface ModelCompatibility {
  name: string;
  url: string;
  bytes: number;
  loadMs: number;
  firstRunMs: number;
  inputs: Array<{ name: string; shape: readonly (number | string)[]; dtype: string }>;
  outputs: Array<{ name: string; shape: readonly (number | string)[]; dtype: string }>;
  status: "compatible" | "failed";
  error?: string;
}
