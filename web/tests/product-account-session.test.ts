import { assertOcrSessionAccount } from "../src/product-account-session.js";

function expectThrows(run: () => void, message: string): void {
  try { run(); } catch { return; }
  throw new Error(message);
}

assertOcrSessionAccount({ sessionAccountId: "account-a", draftAccountId: "account-a", currentAccountId: "account-a", sessionAccountExists: true });
expectThrows(() => assertOcrSessionAccount({ sessionAccountId: "account-a", draftAccountId: "account-b", currentAccountId: "account-a", sessionAccountExists: true }), "draft account mismatch must fail closed");
expectThrows(() => assertOcrSessionAccount({ sessionAccountId: "account-a", draftAccountId: "account-a", currentAccountId: "account-b", sessionAccountExists: true }), "current account mismatch must fail closed");
expectThrows(() => assertOcrSessionAccount({ sessionAccountId: "account-a", draftAccountId: "account-a", currentAccountId: "account-a", sessionAccountExists: false }), "deleted session owner must fail closed");

console.log("product account session checks passed");
