/** Fail-closed ownership guard for an OCR run from creation through final commit. */
export function assertOcrSessionAccount(input: { sessionAccountId: string; draftAccountId: string; currentAccountId: string; sessionAccountExists: boolean }): void {
  if (!input.sessionAccountId || input.draftAccountId !== input.sessionAccountId) throw new Error("识别会话账号无效，已停止应用。");
  if (input.currentAccountId !== input.sessionAccountId || !input.sessionAccountExists) throw new Error("识别会话所属账号已切换或不存在，已停止应用。");
}
