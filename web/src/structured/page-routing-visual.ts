import { edgeMap, ringScore } from "./main-grid.js";
import type { PageEvidence, PageType, Rect } from "./contracts.js";

export interface PageVisualResult {
  pageType: PageType;
  confidence: number;
  evidence: PageEvidence[];
  rect: Rect | null;
  warning: string | null;
}

function toEvidence(value: string, confidence: number, rect?: Rect): PageEvidence {
  return rect ? { source: "visual", value, confidence, rect } : { source: "visual", value, confidence };
}

/**
 * Browser-side equivalent of page_classifier.py's HoughCircles guard.
 * The Canvas runtime has no OpenCV HoughCircles, so reuse the existing ring
 * detector over the same top 16% header region and Python radius/min-distance
 * bounds. Only the >= 3-circle gate affects routing semantics.
 */
export function croppedGridTopCircleCount(image: ImageData, viewport: Rect): number {
  const headerTop = viewport.y;
  const headerBottom = viewport.y + Math.trunc(viewport.height * 0.16);
  const minRadius = Math.max(12, Math.round(viewport.width * 0.055));
  const maxRadius = Math.max(minRadius + 2, Math.round(viewport.width * 0.115));
  const minDistance = Math.max(24, Math.round(viewport.width * 0.12));
  const radiusStep = Math.max(3, Math.round(minRadius * 0.18));
  const xStep = Math.max(6, Math.round(minRadius * 0.22));
  const yStep = Math.max(4, Math.round(minRadius * 0.18));
  if (headerBottom - headerTop < minRadius * 2) return 0;
  const edges = edgeMap(image);
  const candidates: Array<{ centerX: number; centerY: number; radius: number; score: number }> = [];
  for (let centerY = headerTop + minRadius; centerY <= headerBottom - minRadius; centerY += yStep) {
    for (let centerX = viewport.x + minRadius; centerX <= viewport.x + viewport.width - minRadius; centerX += xStep) {
      let bestRadius = minRadius;
      let bestScore = 0;
      for (let radius = minRadius; radius <= maxRadius; radius += radiusStep) {
        const score = ringScore(edges, image.width, image.height, centerX, centerY, radius);
        if (score > bestScore) {
          bestScore = score;
          bestRadius = radius;
        }
      }
      if (bestScore >= 40) candidates.push({ centerX, centerY, radius: bestRadius, score: bestScore });
    }
  }
  const separated: typeof candidates = [];
  for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
    if (separated.some((item) => Math.hypot(item.centerX - candidate.centerX, item.centerY - candidate.centerY) < minDistance)) continue;
    separated.push(candidate);
  }
  return separated.length;
}

function selectedTabVisual(image: ImageData, viewport: Rect): { pageType: PageType; confidence: number; evidence: PageEvidence[]; rect: Rect | null } {
  const top = viewport.y + Math.trunc(viewport.height * 0.07);
  const bottom = viewport.y + Math.trunc(viewport.height * 0.24);
  const step = 2;
  const width = Math.max(1, Math.ceil(viewport.width / step));
  const height = Math.max(1, Math.ceil((bottom - top) / step));
  const mask = new Uint8Array(width * height);
  for (let localY = 0; localY < height; localY += 1) {
    for (let localX = 0; localX < width; localX += 1) {
      const x = Math.min(image.width - 1, viewport.x + localX * step);
      const y = Math.min(image.height - 1, top + localY * step);
      const at = (y * image.width + x) * 4;
      const red = image.data[at] ?? 0;
      const green = image.data[at + 1] ?? 0;
      const blue = image.data[at + 2] ?? 0;
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const delta = max - min;
      const saturation = max ? delta / max * 255 : 0;
      let hue = 0;
      if (delta) {
        if (max === red) hue = 60 * (((green - blue) / delta) % 6);
        else if (max === green) hue = 60 * ((blue - red) / delta + 2);
        else hue = 60 * ((red - green) / delta + 4);
      }
      if (hue < 0) hue += 360;
      const opencvHue = hue / 2;
      if (opencvHue >= 8 && opencvHue <= 42 && saturation >= 25 && saturation <= 210 && max >= 120) mask[localY * width + localX] = 1;
    }
  }
  const visited = new Uint8Array(mask.length);
  const choices: Array<{ area: number; center: number; box: Rect }> = [];
  const queue: number[] = [];
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    queue.length = 0;
    queue.push(seed);
    visited[seed] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const point = queue[cursor]!;
      const y = Math.floor(point / width);
      const x = point - y * width;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] && !visited[next]) { visited[next] = 1; queue.push(next); }
        }
      }
    }
    const componentWidth = (maxX - minX + 1) * step;
    const componentHeight = (maxY - minY + 1) * step;
    const aspect = componentWidth / Math.max(1, componentHeight);
    if (componentWidth < viewport.width * 0.14 || aspect < 1.4 || aspect > 8 || componentHeight > viewport.height * 0.10) continue;
    choices.push({
      area: componentWidth * componentHeight,
      center: (minX + maxX + 1) * step / 2,
      box: {
        x: viewport.x + minX * step,
        y: top + minY * step,
        width: componentWidth,
        height: componentHeight,
      },
    });
  }
  const best = choices.sort((left, right) => right.area - left.area)[0];
  if (!best) return { pageType: "unknown", confidence: 0, evidence: [], rect: null };
  const pageType: PageType = best.center < viewport.width * 0.35 ? "main" : best.center < viewport.width * 0.65 ? "support" : "experience";
  return {
    pageType,
    confidence: 0.82,
    evidence: [toEvidence(`selected_tab_visual:${pageType}`, 0.82, best.box)],
    rect: best.box,
  };
}

export function classifyPageVisual(image: ImageData, viewport: Rect): PageVisualResult {
  if (croppedGridTopCircleCount(image, viewport) >= 3) {
    return { pageType: "unknown", confidence: 0, evidence: [], rect: null, warning: "cropped_grid_top_circles" };
  }
  const visual = selectedTabVisual(image, viewport);
  return { ...visual, warning: null };
}
