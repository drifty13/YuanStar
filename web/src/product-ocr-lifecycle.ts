import type { ProductOcrImportCoordinator } from "./product-ocr-import.js";

type LifecyclePage = {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  addEventListener(type: "pagehide", listener: () => void, options: { once: boolean }): void;
};

/** Call once after the standalone page's first render, for its whole lifetime. */
export function startProductOcrLifecycle(
  coordinator: Pick<ProductOcrImportCoordinator, "prepare" | "dispose">,
  page: LifecyclePage = window,
): void {
  let ended = false;
  let frame = page.requestAnimationFrame(() => {
    if (ended) return;
    // rAF callbacks precede paint. The second frame leaves a paint opportunity
    // between rendering the page and starting optional OCR initialization.
    frame = page.requestAnimationFrame(() => {
      if (ended) return;
      void Promise.resolve().then(() => {
        if (!ended) return coordinator.prepare();
      }).catch(() => undefined);
    });
  });
  page.addEventListener("pagehide", () => {
    ended = true;
    page.cancelAnimationFrame(frame);
    void Promise.resolve().then(() => coordinator.dispose()).catch(() => undefined);
  }, { once: true });
}
