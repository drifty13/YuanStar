import { canUseUiOnlyHistory, pruneStaleUiOnlyHistory } from "../src/product-review-history.js";

function expect(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const beforeWorkspaceMutation = { revisionAfter: 4, workspaceMutation: false, label: "summary navigation" };
const workspaceMutation = { revisionAfter: 5, workspaceMutation: true, label: "plan target" };
const afterWorkspaceMutation = { revisionAfter: 5, workspaceMutation: false, label: "detail navigation" };
const retained = pruneStaleUiOnlyHistory([beforeWorkspaceMutation, workspaceMutation, afterWorkspaceMutation], 5);

expect(retained.map((entry) => entry.label).join(",") === "plan target,detail navigation", "stale UI-only history does not remain ahead of a later workspace mutation");
expect(!canUseUiOnlyHistory(beforeWorkspaceMutation, 5), "stale UI-only entry is unavailable at a newer workspace revision");
expect(canUseUiOnlyHistory(workspaceMutation, 5), "workspace mutation history remains available");
expect(canUseUiOnlyHistory(afterWorkspaceMutation, 5), "current revision UI-only entry remains available");
