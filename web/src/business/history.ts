import type { StarCatalog } from "./catalog.js";
import type { WorkspaceStateV1 } from "./model.js";
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from "./snapshot.js";

export class WorkspaceHistory {
  private readonly undoStack: WorkspaceStateV1[] = [];
  private readonly redoStack: WorkspaceStateV1[] = [];

  constructor(private readonly catalog: StarCatalog, readonly maxSteps = 30) {}
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  record(current: WorkspaceStateV1): void {
    this.undoStack.push(createWorkspaceSnapshot(current, this.catalog));
    if (this.undoStack.length > this.maxSteps) this.undoStack.shift();
    this.redoStack.splice(0);
  }

  undo(current: WorkspaceStateV1): WorkspaceStateV1 | undefined {
    const previous = this.undoStack.pop();
    if (!previous) return undefined;
    this.redoStack.push(createWorkspaceSnapshot(current, this.catalog));
    return restoreWorkspaceSnapshot(previous, this.catalog);
  }

  redo(current: WorkspaceStateV1): WorkspaceStateV1 | undefined {
    const following = this.redoStack.pop();
    if (!following) return undefined;
    this.undoStack.push(createWorkspaceSnapshot(current, this.catalog));
    return restoreWorkspaceSnapshot(following, this.catalog);
  }
}
