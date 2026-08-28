import * as ort from "onnxruntime-web/wasm";
import type { ModelCompatibility, OcrBox, OcrLine, RawOcrResult, Timings } from "./types.js";
import { createRuntimeCanvas, type RuntimeCanvas } from "./structured/image-canvas-runtime.js";
import { runProgressiveVariantFallback } from "./structured/variant-fallback.js";

let modelRoot = new URL("/models/", location.href);
const MODEL_SPECS = [
  { name: "PP-OCRv6 检测", file: "PP-OCRv6_det_small.onnx", bytes: 9_929_594, dummy: [1, 3, 64, 64] },
  { name: "PP-OCRv4 方向分类", file: "ch_ppocr_mobile_v2.0_cls_mobile.onnx", bytes: 585_532, dummy: [1, 3, 48, 192] },
  { name: "PP-OCRv6 识别", file: "PP-OCRv6_rec_small.onnx", bytes: 21_234_383, dummy: [1, 3, 48, 320] },
] as const;

interface LoadedModels {
  detection: ort.InferenceSession;
  classification: ort.InferenceSession;
  recognition: ort.InferenceSession;
  characters: string[];
}

interface PreparedImage {
  tensor: ort.Tensor;
  canvas: RuntimeCanvas;
  scaleX: number;
  scaleY: number;
}

let models: LoadedModels | undefined;
let compatibility: ModelCompatibility[] = [];
let sessionCreationCount = 0;
let recognitionCallCount = 0;

ort.env.wasm.wasmPaths = new URL("/ort/", location.href).href;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function metadata(session: ort.InferenceSession, kind: "input" | "output") {
  const names = kind === "input" ? session.inputNames : session.outputNames;
  const items = kind === "input" ? session.inputMetadata : session.outputMetadata;
  return names.map((name, index) => {
    const item = items[index];
    return {
      name,
      shape: item?.isTensor ? item.shape.map((part: number | string) => typeof part === "number" ? part : String(part)) : [],
      dtype: item?.isTensor ? item.type : "non-tensor",
    };
  });
}

export async function loadAndVerifyModels(config: { modelRoot?: string } = {}): Promise<ModelCompatibility[]> {
  if (models) return compatibility;
  if (config.modelRoot) {
    const requested = new URL(config.modelRoot, location.href);
    if (requested.origin !== location.origin) throw new Error("worker_runtime_unavailable: modelRoot must be same-origin");
    modelRoot = requested.href.endsWith("/") ? requested : new URL("./", requested);
  }
  ort.env.wasm.wasmPaths = new URL("../ort/", modelRoot).href;

  const sessions: ort.InferenceSession[] = [];
  const results: ModelCompatibility[] = [];
  for (const spec of MODEL_SPECS) {
    const url = new URL(spec.file, modelRoot).href;
    const started = performance.now();
    try {
      const session = await ort.InferenceSession.create(url, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      sessionCreationCount += 1;
      const loadedAt = performance.now();
      const dims: number[] = Array.from(spec.dummy);
      const tensor = new ort.Tensor("float32", new Float32Array(dims.reduce((a, b) => a * b, 1)), dims);
      await session.run({ [session.inputNames[0]!]: tensor });
      const finished = performance.now();
      sessions.push(session);
      results.push({
        name: spec.name,
        url,
        bytes: spec.bytes,
        loadMs: round(loadedAt - started),
        firstRunMs: round(finished - loadedAt),
        inputs: metadata(session, "input"),
        outputs: metadata(session, "output"),
        status: "compatible",
      });
    } catch (error) {
      results.push({
        name: spec.name,
        url,
        bytes: spec.bytes,
        loadMs: round(performance.now() - started),
        firstRunMs: 0,
        inputs: [],
        outputs: [],
        status: "failed",
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      compatibility = results;
      throw new Error(`${spec.name} 浏览器兼容性失败：${results.at(-1)?.error}`);
    }
  }

  const dictionaryResponse = await fetch(new URL("ppocrv6_chars.txt", modelRoot));
  if (!dictionaryResponse.ok) throw new Error(`字符表加载失败：HTTP ${dictionaryResponse.status}`);
  const characters = (await dictionaryResponse.text()).split(/\r?\n/u).filter((line) => line.length > 0);
  if (characters.length !== 18_708) throw new Error(`字符表长度异常：${characters.length}，预期 18708`);

  models = { detection: sessions[0]!, classification: sessions[1]!, recognition: sessions[2]!, characters };
  compatibility = results;
  return results;
}

export function isModelLoaded(): boolean {
  return models != null;
}

export function getOcrRuntimeMetrics(): { sessionCreationCount: number; recognitionCallCount: number } {
  return { sessionCreationCount, recognitionCallCount };
}

export async function disposeLocalOcr(): Promise<void> {
  const current = models;
  models = undefined;
  compatibility = [];
  if (!current) return;
  await Promise.all([current.detection, current.classification, current.recognition].map(async (session) => {
    try { await session.release(); } catch { /* release is best effort in browser PoC */ }
  }));
}

function canvasFor(width: number, height: number): RuntimeCanvas { return createRuntimeCanvas(width, height); }

function imageDataToTensor(imageData: ImageData, width: number, height: number, normalizePadding = false): ort.Tensor {
  const plane = width * height;
  const values = new Float32Array(plane * 3);
  for (let index = 0; index < plane; index += 1) {
    const rgba = index * 4;
    const r = imageData.data[rgba] ?? 0;
    const g = imageData.data[rgba + 1] ?? 0;
    const b = imageData.data[rgba + 2] ?? 0;
    values[index] = (b / 255 - 0.5) / 0.5;
    values[plane + index] = (g / 255 - 0.5) / 0.5;
    values[plane * 2 + index] = (r / 255 - 0.5) / 0.5;
  }
  if (normalizePadding) return new ort.Tensor("float32", values, [1, 3, height, width]);
  return new ort.Tensor("float32", values, [1, 3, height, width]);
}

function prepareDetection(bitmap: ImageBitmap): PreparedImage {
  const cap = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(32, Math.round(bitmap.width * cap / 32) * 32);
  const height = Math.max(32, Math.round(bitmap.height * cap / 32) * 32);
  const canvas = canvasFor(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法创建 2D Canvas 上下文");
  context.drawImage(bitmap, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  return {
    tensor: imageDataToTensor(imageData, width, height),
    canvas,
    scaleX: bitmap.width / width,
    scaleY: bitmap.height / height,
  };
}

function outputMap(output: ort.Tensor): { data: Float32Array; width: number; height: number } {
  const dims = output.dims.map(Number);
  const height = dims.at(-2) ?? 0;
  const width = dims.at(-1) ?? 0;
  if (!width || !height || !(output.data instanceof Float32Array)) throw new Error(`检测输出异常：${JSON.stringify(output.dims)}`);
  return { data: output.data, width, height };
}

function detectBoxes(output: ort.Tensor, sourceWidth: number, sourceHeight: number): OcrBox[] {
  const { data, width, height } = outputMap(output);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x;
      if ((data[at] ?? 0) <= 0.3) continue;
      mask[at] = 1;
      if (x + 1 < width) mask[at + 1] = 1;
      if (y + 1 < height) mask[at + width] = 1;
      if (x + 1 < width && y + 1 < height) mask[at + width + 1] = 1;
    }
  }

  const visited = new Uint8Array(mask.length);
  const boxes: OcrBox[] = [];
  const queue: number[] = [];
  for (let seed = 0; seed < mask.length && boxes.length < 100; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    queue.length = 0;
    queue.push(seed);
    visited[seed] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let score = 0;
    let count = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const point = queue[cursor]!;
      const y = Math.floor(point / width);
      const x = point - y * width;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      score += data[point] ?? 0;
      count += 1;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }
    }
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const meanScore = score / Math.max(1, count);
    if (Math.min(boxWidth, boxHeight) < 3 || meanScore < 0.5) continue;
    const expansion = Math.max(2, Math.round((boxWidth * boxHeight * 1.6) / (2 * (boxWidth + boxHeight))));
    const left = Math.max(0, minX - expansion);
    const top = Math.max(0, minY - expansion);
    const right = Math.min(width, maxX + expansion + 1);
    const bottom = Math.min(height, maxY + expansion + 1);
    const x = Math.round(left / width * sourceWidth);
    const y = Math.round(top / height * sourceHeight);
    const w = Math.max(1, Math.round((right - left) / width * sourceWidth));
    const h = Math.max(1, Math.round((bottom - top) / height * sourceHeight));
    if (w >= 3 && h >= 3) boxes.push({ x, y, width: w, height: h, detectionConfidence: round(meanScore) });
  }
  return boxes.sort((a, b) => Math.abs(a.y - b.y) < 10 ? a.x - b.x : a.y - b.y).slice(0, 32);
}

function prepareRecognition(bitmap: ImageBitmap, box: OcrBox): ort.Tensor {
  const ratio = box.width / Math.max(1, box.height);
  const targetHeight = 48;
  const resizedWidth = Math.max(1, Math.min(960, Math.ceil(targetHeight * ratio)));
  const targetWidth = Math.max(320, resizedWidth);
  const canvas = canvasFor(resizedWidth, targetHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法创建文字识别 Canvas");
  context.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, resizedWidth, targetHeight);
  const image = context.getImageData(0, 0, resizedWidth, targetHeight);
  const plane = targetWidth * targetHeight;
  const values = new Float32Array(plane * 3);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < resizedWidth; x += 1) {
      const source = (y * resizedWidth + x) * 4;
      const target = y * targetWidth + x;
      values[target] = (((image.data[source + 2] ?? 0) / 255) - 0.5) / 0.5;
      values[plane + target] = (((image.data[source + 1] ?? 0) / 255) - 0.5) / 0.5;
      values[plane * 2 + target] = (((image.data[source] ?? 0) / 255) - 0.5) / 0.5;
    }
  }
  return new ort.Tensor("float32", values, [1, 3, targetHeight, targetWidth]);
}

function decodeRecognition(output: ort.Tensor, characters: string[]): { text: string; confidence: number } {
  const dims = output.dims.map(Number);
  const steps = dims.at(-2) ?? 0;
  const classes = dims.at(-1) ?? 0;
  if (!steps || classes !== characters.length + 2 || !(output.data instanceof Float32Array)) {
    throw new Error(`识别输出异常：${JSON.stringify(output.dims)}`);
  }
  const text: string[] = [];
  const confidences: number[] = [];
  let previous = -1;
  for (let step = 0; step < steps; step += 1) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    const offset = step * classes;
    for (let index = 0; index < classes; index += 1) {
      const value = output.data[offset + index] as number;
      if (value > bestScore) {
        bestScore = value;
        bestIndex = index;
      }
    }
    if (bestIndex !== 0 && bestIndex !== previous) {
      text.push(bestIndex === characters.length + 1 ? " " : (characters[bestIndex - 1] ?? "?"));
      confidences.push(bestScore);
    }
    previous = bestIndex;
  }
  const confidence = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 0;
  return { text: text.join(""), confidence: round(confidence) };
}

const STRUCTURED_NAME_LEVEL_RECOGNITION_MIN_WIDTH = 160;

function prepareRecognitionCanvas(canvas: RuntimeCanvas, minimumWidth = 320): ort.Tensor {
  const ratio = canvas.width / Math.max(1, canvas.height);
  const targetHeight = 48;
  const resizedWidth = Math.max(1, Math.min(960, Math.ceil(targetHeight * ratio)));
  const targetWidth = Math.max(minimumWidth, resizedWidth);
  const resized = canvasFor(resizedWidth, targetHeight);
  const context = resized.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法创建 ROI 识别 Canvas");
  context.drawImage(canvas, 0, 0, resizedWidth, targetHeight);
  const image = context.getImageData(0, 0, resizedWidth, targetHeight);
  const plane = targetWidth * targetHeight;
  const values = new Float32Array(plane * 3);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < resizedWidth; x += 1) {
      const source = (y * resizedWidth + x) * 4;
      const target = y * targetWidth + x;
      values[target] = (((image.data[source + 2] ?? 0) / 255) - 0.5) / 0.5;
      values[plane + target] = (((image.data[source + 1] ?? 0) / 255) - 0.5) / 0.5;
      values[plane * 2 + target] = (((image.data[source] ?? 0) / 255) - 0.5) / 0.5;
    }
  }
  return new ort.Tensor("float32", values, [1, 3, targetHeight, targetWidth]);
}

export type PreparedRoiVariant = { variant: string; canvas: RuntimeCanvas };

export function prepareRectVariants(
  bitmap: ImageBitmap,
  box: { x: number; y: number; width: number; height: number },
): PreparedRoiVariant[] {
  const scale = 3;
  const width = Math.max(1, Math.round(box.width * scale));
  const height = Math.max(1, Math.round(box.height * scale));
  const color = canvasFor(width, height);
  const colorContext = color.getContext("2d", { willReadFrequently: true });
  if (!colorContext) throw new Error("浏览器无法创建 ROI 预处理 Canvas");
  colorContext.imageSmoothingEnabled = true;
  colorContext.imageSmoothingQuality = "high";
  colorContext.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, width, height);
  const source = colorContext.getImageData(0, 0, width, height);
  const contrast = canvasFor(width, height);
  const contrastContext = contrast.getContext("2d", { willReadFrequently: true });
  if (!contrastContext) throw new Error("浏览器无法创建对比度 Canvas");
  const contrastData = contrastContext.createImageData(width, height);
  const histogram = new Uint32Array(256);
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4;
    const gray = Math.round(((source.data[at] ?? 0) * 299 + (source.data[at + 1] ?? 0) * 587 + (source.data[at + 2] ?? 0) * 114) / 1000);
    const adjusted = Math.max(0, Math.min(255, Math.round(gray * 1.7 - 35)));
    contrastData.data[at] = adjusted;
    contrastData.data[at + 1] = adjusted;
    contrastData.data[at + 2] = adjusted;
    contrastData.data[at + 3] = 255;
    histogram[adjusted] = (histogram[adjusted] ?? 0) + 1;
  }
  contrastContext.putImageData(contrastData, 0, 0);
  const total = width * height;
  let totalWeighted = 0;
  histogram.forEach((count, value) => { totalWeighted += count * value; });
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let threshold = 127;
  histogram.forEach((count, value) => {
    backgroundWeight += count;
    if (!backgroundWeight || backgroundWeight === total) return;
    backgroundSum += count * value;
    const foregroundWeight = total - backgroundWeight;
    const delta = backgroundSum / backgroundWeight - (totalWeighted - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * delta * delta;
    if (variance > bestVariance) { bestVariance = variance; threshold = value; }
  });
  const otsu = canvasFor(width, height);
  const otsuContext = otsu.getContext("2d", { willReadFrequently: true });
  if (!otsuContext) throw new Error("浏览器无法创建 Otsu Canvas");
  const otsuData = otsuContext.createImageData(width, height);
  for (let index = 0; index < total; index += 1) {
    const at = index * 4;
    const value = (contrastData.data[at] ?? 0) > threshold ? 255 : 0;
    otsuData.data[at] = value; otsuData.data[at + 1] = value; otsuData.data[at + 2] = value; otsuData.data[at + 3] = 255;
  }
  otsuContext.putImageData(otsuData, 0, 0);
  return [{ variant: "color", canvas: color }, { variant: "contrast", canvas: contrast }, { variant: "otsu", canvas: otsu }];
}

export async function recognizeRectVariants(
  bitmap: ImageBitmap,
  box: { x: number; y: number; width: number; height: number },
): Promise<Array<{ text: string; confidence: number; variant: string }>> {
  return recognizePreparedRectVariants(prepareRectVariants(bitmap, box));
}

export async function recognizePreparedRectVariants(
  variants: PreparedRoiVariant[],
  minimumWidth = 320,
): Promise<Array<{ text: string; confidence: number; variant: string }>> {
  if (!models) throw new Error("请先加载并验证模型");
  const results: Array<{ text: string; confidence: number; variant: string }> = [];
  for (const item of variants) {
    recognitionCallCount += 1;
    const tensor = prepareRecognitionCanvas(item.canvas, minimumWidth);
    const output = await models.recognition.run({ [models.recognition.inputNames[0]!]: tensor });
    const decoded = decodeRecognition(output[models.recognition.outputNames[0]!]!, models.characters);
    results.push({ ...decoded, variant: item.variant });
  }
  return results;
}

/**
 * Field-specific callers may accept a single safe color candidate. Otherwise
 * the original contrast and Otsu candidates are recognized in full order.
 */
export async function recognizePreparedRectVariantsWithFallback(
  variants: PreparedRoiVariant[],
  canAcceptFirst: (candidate: { text: string; confidence: number; variant: string }) => boolean,
  forceFullVariants = false,
  canAcceptFirstTwo?: (
    first: { text: string; confidence: number; variant: string },
    second: { text: string; confidence: number; variant: string },
  ) => boolean,
): Promise<Array<{ text: string; confidence: number; variant: string }>> {
  return runProgressiveVariantFallback(
    variants,
    (prepared) => recognizePreparedRectVariants(prepared, STRUCTURED_NAME_LEVEL_RECOGNITION_MIN_WIDTH),
    canAcceptFirst,
    forceFullVariants,
    canAcceptFirstTwo,
  );
}

export async function runLocalOcr(file: File): Promise<{ bitmap: ImageBitmap; result: RawOcrResult; timings: Timings }> {
  if (!models) throw new Error("请先加载并验证模型");
  const totalStart = performance.now();
  const decodeStart = performance.now();
  const bitmap = await createImageBitmap(file);
  const decodedAt = performance.now();

  const prepared = prepareDetection(bitmap);
  const preprocessedAt = performance.now();
  const detectionOutputs = await models.detection.run({ [models.detection.inputNames[0]!]: prepared.tensor });
  const detectedAt = performance.now();
  const detectionTensor = detectionOutputs[models.detection.outputNames[0]!]!;
  let boxes = detectBoxes(detectionTensor, bitmap.width, bitmap.height);
  const postprocessedAt = performance.now();
  if (boxes.length === 0) {
    boxes = [{ x: 0, y: 0, width: bitmap.width, height: bitmap.height, detectionConfidence: 0 }];
  }

  const lines: OcrLine[] = [];
  let recognitionInferenceMs = 0;
  let recognitionPostprocessMs = 0;
  for (const box of boxes) {
    const tensor = prepareRecognition(bitmap, box);
    recognitionCallCount += 1;
    const inferenceStart = performance.now();
    const outputs = await models.recognition.run({ [models.recognition.inputNames[0]!]: tensor });
    const inferenceEnd = performance.now();
    const decoded = decodeRecognition(outputs[models.recognition.outputNames[0]!]!, models.characters);
    const decodeEnd = performance.now();
    recognitionInferenceMs += inferenceEnd - inferenceStart;
    recognitionPostprocessMs += decodeEnd - inferenceEnd;
    if (decoded.text.trim()) lines.push({ ...decoded, box });
  }
  const finished = performance.now();
  const timings: Timings = {
    decodeMs: round(decodedAt - decodeStart),
    preprocessMs: round(preprocessedAt - decodedAt),
    detectionInferenceMs: round(detectedAt - preprocessedAt),
    detectionPostprocessMs: round(postprocessedAt - detectedAt),
    recognitionInferenceMs: round(recognitionInferenceMs),
    recognitionPostprocessMs: round(recognitionPostprocessMs),
    totalMs: round(finished - totalStart),
  };
  return {
    bitmap,
    result: {
      engine: "onnxruntime-web wasm; RapidOCR PP-OCRv6 det/rec; PP-OCRv4 cls compatibility-checked",
      scope: "axis-aligned DB-map approximation; upright text; whole-image fallback when no boxes are found",
      lines,
    },
    timings,
  };
}
