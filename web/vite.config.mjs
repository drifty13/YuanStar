import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  base: "/",
  // Keep ORT's MJS/WASM external while preserving Vite's default client resolution.
  resolve: {
    conditions: ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions],
  },
});
