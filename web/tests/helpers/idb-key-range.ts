// Minimal compound-key range surface used by the existing in-memory IDB doubles.
// Production browser range semantics are verified separately in runtime smoke.
class CompoundKeyRange {
  constructor(readonly lower: unknown[], readonly upper: unknown[]) {}
  includes(key: unknown): boolean {
    if (!Array.isArray(key)) return false;
    if (this.lower.length !== 1 || this.upper.length !== 2 || !Array.isArray(this.upper[1])) throw new Error("unsupported test range");
    return key[0] === this.lower[0];
  }
  static bound(lower: unknown[], upper: unknown[]): CompoundKeyRange { return new CompoundKeyRange(lower, upper); }
}
Object.defineProperty(globalThis, "IDBKeyRange", { value: CompoundKeyRange, configurable: true });
export {};
