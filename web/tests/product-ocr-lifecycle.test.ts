import { startProductOcrLifecycle } from "../src/product-ocr-lifecycle.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
class FakePage {
  frames = new Map<number, FrameRequestCallback>();
  listeners: Array<{ type: string; listener: () => void; once: boolean }> = [];
  private nextFrame = 0;
  requestAnimationFrame(callback: FrameRequestCallback): number { this.frames.set(++this.nextFrame, callback); return this.nextFrame; }
  cancelAnimationFrame(handle: number): void { this.frames.delete(handle); }
  addEventListener(type: "pagehide", listener: () => void, options: { once: boolean }): void { this.listeners.push({ type, listener, once: options.once }); }
  paint(): void { const callbacks = [...this.frames.values()]; this.frames.clear(); callbacks.forEach((callback) => callback(0)); }
  exit(): void { const listeners = [...this.listeners]; this.listeners = this.listeners.filter((item) => !item.once); listeners.forEach((item) => item.listener()); }
}
const tick = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const page = new FakePage();
let prepares = 0, disposals = 0;
startProductOcrLifecycle({ prepare: async () => { prepares++; throw new Error("background unavailable"); }, dispose: async () => { disposals++; } }, page);
expect(prepares === 0, "first render/startup must return without waiting for OCR");
page.paint();
await tick();
expect(prepares === 0, "first rAF must allow a paint before OCR preparation");
page.paint();
await tick();
expect(Number(prepares) === 1, "second rAF must prepare without images and silently catch rejection");
page.paint();
await tick();
expect(Number(prepares) === 1 && disposals === 0, "later renders must not prepare or dispose again");
expect(page.listeners.length === 1 && page.listeners[0]?.type === "pagehide", "runtime lifecycle listens only for page exit, never accounts or tabs");
page.exit(); page.exit();
await tick();
expect(Number(disposals) === 1, "page exit must release the coordinator exactly once");
for (const paintedFrames of [0, 1]) {
  const earlyPage = new FakePage();
  let started = 0, stopped = 0;
  startProductOcrLifecycle({ prepare: async () => { started++; }, dispose: async () => { stopped++; throw new Error("cleanup unavailable"); } }, earlyPage);
  if (paintedFrames) earlyPage.paint();
  earlyPage.exit(); earlyPage.paint(); earlyPage.paint();
  await tick();
  expect(started === 0 && stopped === 1 && earlyPage.frames.size === 0, "exit before either frame must cancel prepare and safely catch disposal failure");
}
const throwingPage = new FakePage();
startProductOcrLifecycle({ prepare: () => { throw new Error("synchronous startup failure"); }, dispose: async () => undefined }, throwingPage);
throwingPage.paint(); throwingPage.paint(); await tick(); throwingPage.exit(); await tick();
console.log("P4 standalone lifecycle checks passed: paint ordering, silent failure, one page exit, cancelled frames");
