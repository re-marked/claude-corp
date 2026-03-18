export type View =
  | { type: 'chat'; channelId: string }
  | { type: 'task-board' }
  | { type: 'task-detail'; taskId: string }
  | { type: 'agent-inspector'; memberId: string }
  | { type: 'hierarchy' }
  | { type: 'corp-home' };

export class ViewStack {
  private stack: View[] = [];

  push(view: View): void {
    this.stack.push(view);
  }

  pop(): View | undefined {
    if (this.stack.length <= 1) return undefined; // Don't pop the root
    return this.stack.pop();
  }

  current(): View | undefined {
    return this.stack[this.stack.length - 1];
  }

  replace(view: View): void {
    if (this.stack.length > 0) {
      this.stack[this.stack.length - 1] = view;
    } else {
      this.stack.push(view);
    }
  }

  clear(root: View): void {
    this.stack = [root];
  }

  depth(): number {
    return this.stack.length;
  }

  /** Get breadcrumb labels for the current stack. */
  breadcrumbs(): string[] {
    return this.stack.map((v) => {
      switch (v.type) {
        case 'chat': return `#${v.channelId}`;
        case 'task-board': return 'Tasks';
        case 'task-detail': return `Task`;
        case 'agent-inspector': return 'Agent';
        case 'hierarchy': return 'Hierarchy';
        case 'corp-home': return 'Home';
      }
    });
  }
}
