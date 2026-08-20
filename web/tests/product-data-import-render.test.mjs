import { readFileSync } from "node:fs";

function expect(value, message) {
  if (!value) throw new Error(message);
}

const productSource = readFileSync(new URL("../src/product.ts", import.meta.url), "utf8");
const prepareImport = productSource.match(/async function prepareDataImport\(file: File\): Promise<void> \{[\s\S]*?\n\}\n\nasync function confirmDataImport/);

expect(prepareImport, "data import preparation must remain a distinct UI boundary");
expect(prepareImport[0].includes("renderPage();"), "completed data import preparation must refresh the page shell that contains the import dialog");
expect(!prepareImport[0].includes("renderReview();"), "completed data import preparation must not refresh only the review region");
expect(productSource.includes("${dataToolsTemplate()}"), "the import dialog must remain part of the full page shell");

console.log("product data import render regression checks passed");
