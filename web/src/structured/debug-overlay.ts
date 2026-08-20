import type { StructuredExperienceOutput, StructuredMainOutput } from "./types.js";

export interface OverlayOptions { content: boolean; cards: boolean; names: boolean; levels: boolean; labels: boolean }

export function drawStructuredOverlay(canvas: HTMLCanvasElement, bitmap: ImageBitmap, output: StructuredMainOutput, options: OverlayOptions): void {
  const maxWidth = Math.min(900, Math.max(320, document.documentElement.clientWidth - 48));
  const scale = Math.min(1, maxWidth / bitmap.width);
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建结构化叠图 Canvas");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  context.lineWidth = 2;
  const stroke = (rect: { x: number; y: number; width: number; height: number }, color: string): void => {
    context.strokeStyle = color;
    context.strokeRect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale);
  };
  if (options.content) stroke(output.profile.contentBounds, "#5dd6a2");
  output.candidates.forEach((card) => {
    if (options.cards) stroke(card.cardRect, card.completeness === "complete" ? "#ffcc00" : "#ff6b6b");
    if (options.names) stroke(card.nameRect, "#42a5f5");
    if (options.levels) stroke(card.levelRect, "#d875ff");
    if (options.labels) {
      context.fillStyle = "#111827";
      context.font = "12px sans-serif";
      context.fillText(`r${card.rowIndex + 1}c${card.columnIndex + 1} ${card.completeness}`, card.cardRect.x * scale, Math.max(12, card.cardRect.y * scale - 3));
    }
  });
}

export interface ExperienceOverlayOptions { content: boolean; icons: boolean; counts: boolean; labels: boolean }

export function drawExperienceOverlay(canvas: HTMLCanvasElement, bitmap: ImageBitmap, output: StructuredExperienceOutput, options: ExperienceOverlayOptions): void {
  const maxWidth = Math.min(900, Math.max(320, document.documentElement.clientWidth - 48));
  const scale = Math.min(1, maxWidth / bitmap.width);
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建经验星曜叠图 Canvas");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  context.lineWidth = 2;
  const stroke = (rect: { x: number; y: number; width: number; height: number }, color: string): void => {
    context.strokeStyle = color;
    context.strokeRect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale);
  };
  if (options.content) stroke(output.profile.contentBounds, "#5dd6a2");
  output.candidates.forEach((item) => {
    if (options.icons) stroke(item.iconRect, item.completeness === "complete" ? "#ffcc00" : "#ff6b6b");
    if (options.counts) stroke(item.countRect, "#d875ff");
    if (options.labels) {
      context.fillStyle = "#111827";
      context.font = "12px sans-serif";
      context.fillText(`#${item.index + 1} ${item.completeness}`, item.iconRect.x * scale, Math.max(12, item.iconRect.y * scale - 3));
    }
  });
}
