import { isCommittedImportDraft, reviewRunContext, reviewSourceBlob, runProductOcrCommitHandoff } from "../src/product-ocr-commit-handoff.js";
import { WorkspaceRevisionConflictError } from "../src/business/persistence/repository.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const witness = { accountId: "A", sourceImageIds: ["a", "b"], reviewSourceImageIds: ["b", "a"] };
expect(isCommittedImportDraft({ accountId: "A", imageOrder: ["a", "b"] }, witness), "exact same-account source sets match independently of order");
for (const draft of [
  { accountId: "B", imageOrder: ["a", "b"] }, { accountId: "A", imageOrder: ["a"] },
  { accountId: "A", imageOrder: ["a", "b", "c"] }, { accountId: "A", imageOrder: ["a", "a"] },
  { accountId: "A", imageOrder: [] }, { accountId: "A", imageOrder: ["new-a", "new-b"] },
]) expect(!isCommittedImportDraft(draft, witness), "unproven or new Draft identity is retained");
expect(!isCommittedImportDraft({ accountId: "A", imageOrder: ["a", "b"] }, { ...witness, reviewSourceImageIds: ["a"] }), "incomplete review witness cannot delete Draft");
const prior = { images: [{ sourceImageId: "a", file: new Blob(["old File"]) }] };
expect(reviewRunContext({}, prior) === prior && reviewRunContext({ runContext: null }, prior) === null, "omission preserves prior; explicit null releases it");

for (const failure of [new Error("commit reject"), new WorkspaceRevisionConflictError("A", 1, 2)]) {
  let retired = false, applied = false;
  let thrown: unknown;
  try {
    await runProductOcrCommitHandoff({ commit: async () => { throw failure; }, isCurrent: () => true,
      applyCommitted: () => { applied = true; }, retireDraft: async () => { retired = true; },
      retireMemory: () => { retired = true; }, usePersistedReview: () => { retired = true; } });
  } catch (error) { thrown = error; }
  expect(thrown === failure && !retired && !applied, "commit rejection/conflict preserves Draft and URLs");
}

for (const failCleanup of [false, true]) {
  const order: string[] = [];
  let finish!: (value: { blob: Blob }) => void;
  const commit = new Promise<{ blob: Blob }>((resolve) => { finish = resolve; });
  let persisted: Blob | undefined, runContext: typeof prior | null = prior;
  let memoryImages = ["a", "b"], overlap = ["pair"], draftUrlLive = true;
  const outcome = runProductOcrCommitHandoff({
    commit: () => commit, isCurrent: () => true,
    applyCommitted: (value) => { order.push("apply"); persisted = value.blob; },
    retireDraft: async () => { order.push("retire"); expect(persisted, "durable source is truth before retirement"); if (failCleanup) throw new Error("disk full"); },
    retireMemory: () => { order.push("memory"); memoryImages = []; overlap = []; draftUrlLive = false; },
    usePersistedReview: () => { order.push("review"); runContext = reviewRunContext({ runContext: null }, runContext); },
  });
  await Promise.resolve();
  expect(order.length === 0 && draftUrlLive && memoryImages.length === 2, "pending commit never clears Draft");
  order.push("commit"); finish({ blob: new Blob(["persisted screenshot"], { type: "image/png" }) });
  expect(await outcome === (failCleanup ? "cleanup_failed" : "saved"), "cleanup warning preserves business success");
  expect(order.join(",") === "commit,apply,retire,memory,review", "precise durable commit and housekeeping sequence");
  expect(!runContext && !draftUrlLive && Number(memoryImages.length) === 0 && overlap.length === 0, "success retires memory and all old source references");
  let persistedReads = 0;
  const getSource = async () => { persistedReads++; return persisted; };
  const wholePage = await reviewSourceBlob(runContext, "a", getSource);
  const cropSource = await reviewSourceBlob(runContext, "a", getSource);
  const refreshedCropSource = await reviewSourceBlob(null, "a", getSource);
  expect(wholePage === persisted && cropSource === persisted && refreshedCropSource === persisted && persistedReads === 3,
    "whole-page and row crop use persisted Blob after revoke and refresh");
  const independentViewerUrl = URL.createObjectURL(wholePage!);
  expect(await (await fetch(independentViewerUrl)).text() === "persisted screenshot", "independent viewer URL reads persisted Blob");
  URL.revokeObjectURL(independentViewerUrl);
  let revoked = false;
  try { await fetch(independentViewerUrl); } catch { revoked = true; }
  expect(revoked && await persisted!.text() === "persisted screenshot", "viewer close revokes only its URL, never durable Blob");
}

let touched = false;
expect(await runProductOcrCommitHandoff({ commit: async () => 1, isCurrent: () => false,
  applyCommitted: () => { touched = true; }, retireDraft: async () => { touched = true; },
  retireMemory: () => { touched = true; }, usePersistedReview: () => { touched = true; } }) === "stale" && !touched,
  "stale account/generation does not retire another Draft");
console.log("PASS P5 commit handoff: commit boundary, rejection/conflict, best-effort cleanup, identities and persisted review URL ownership");
