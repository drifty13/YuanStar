let fallbackCounter = 0;

function stablePart(value: string): string {
  return encodeURIComponent(value.trim() || "unknown");
}

/**
 * Contract occurrence identity is intentionally separate from local storage IDs.
 * It is derived only from image identity, page type, and stable geometry order;
 * OCR values, inferred values, and manual overlays cannot change it.
 */
export function createOccurrenceId(
  imageId: string,
  pageType: "main" | "support",
  position: { row: number; column: number },
): string;
export function createOccurrenceId(
  imageId: string,
  pageType: "experience",
  position: { ordinal: number },
): string;
export function createOccurrenceId(
  imageId: string,
  pageType: "main" | "support" | "experience" | "unknown",
  position: { row: number; column: number } | { ordinal: number },
): string {
  const image = stablePart(imageId);
  if ("row" in position) return `occurrence:v1:${image}:${pageType}:r${position.row}c${position.column}`;
  return `occurrence:v1:${image}:${pageType}:o${position.ordinal}`;
}

/**
 * Prefer a content digest so a repeated analysis of the same image remains
 * stable even when a new File wrapper is created by clipboard input.
 */
export async function createStableImageId(file: File): Promise<string> {
  try {
    if (globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const bytes = new Uint8Array(digest);
      return `sha256-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
    }
  } catch {
    // The deterministic metadata fallback below is sufficient for local PoC use.
  }
  return `file-${stablePart(file.name)}-${file.size}-${file.lastModified}`;
}

/**
 * Creates an identifier for a browser-local PoC record.
 *
 * This value is not an authentication token, key, session secret, or security
 * boundary. The final fallback only preserves local record uniqueness when a
 * browser exposes neither Web Crypto API used below.
 */
export function createLocalId(): string {
  const cryptoApi = globalThis.crypto;

  if (globalThis.isSecureContext && typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }

  fallbackCounter += 1;
  return `local-${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random().toString(36).slice(2)}`;
}
