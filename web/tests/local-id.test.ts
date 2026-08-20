import { createLocalId } from "../src/utils/id.js";

interface CryptoStub {
  getRandomValues(values: Uint8Array): Uint8Array;
  randomUUID?: () => string;
}

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const originalSecureContext = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");

function setEnvironment(cryptoApi: CryptoStub | undefined, isSecureContext: boolean): void {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: cryptoApi });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: isSecureContext });
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  setEnvironment({ getRandomValues: (values) => values, randomUUID: () => "native-local-id" }, true);
  expect(createLocalId() === "native-local-id", "secure contexts should use native randomUUID");

  setEnvironment({
    getRandomValues: (values) => {
      values.forEach((_, index) => { values[index] = index; });
      return values;
    },
  }, false);
  const webCryptoId = createLocalId();
  expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(webCryptoId), "Web Crypto fallback should create UUID v4");

  setEnvironment(undefined, false);
  const firstFallback = createLocalId();
  const secondFallback = createLocalId();
  expect(firstFallback.length > 0 && secondFallback.length > 0, "fallback IDs should be non-empty");
  expect(firstFallback !== secondFallback, "fallback IDs should not repeat");

  console.log("local ID compatibility checks passed");
} finally {
  if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
  else Reflect.deleteProperty(globalThis, "crypto");
  if (originalSecureContext) Object.defineProperty(globalThis, "isSecureContext", originalSecureContext);
  else Reflect.deleteProperty(globalThis, "isSecureContext");
}
