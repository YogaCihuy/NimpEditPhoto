const MAX_ENTRIES = 40;
const MAX_BYTES = 120 * 1024 * 1024;

export class History {
  constructor(onChange) {
    this.onChange = onChange || (() => {});
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  push(command) {
    if (!command) return;
    command.bytes = Number(command.bytes) || 0;
    if (this.redoStack.length) {
      this.bytes -= this.redoStack.reduce((sum, cmd) => sum + (cmd.bytes || 0), 0);
      this.redoStack = [];
    }
    this.undoStack.push(command);
    this.bytes += command.bytes;
    this.trim();
    this.onChange();
  }

  last() {
    return this.undoStack[this.undoStack.length - 1] || null;
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return false;
    command.undo();
    this.redoStack.push(command);
    this.onChange();
    return true;
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return false;
    command.redo();
    this.undoStack.push(command);
    this.onChange();
    return true;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
    this.onChange();
  }

  trim() {
    while (
      this.undoStack.length > MAX_ENTRIES ||
      (this.bytes > MAX_BYTES && this.undoStack.length > 1)
    ) {
      const dropped = this.undoStack.shift();
      this.bytes -= dropped.bytes || 0;
    }
  }
}
