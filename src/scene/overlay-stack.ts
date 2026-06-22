// A LIFO stack of overlay screens layered over a persistent root screen.
// Pure data structure — no Three.js, no DOM, no Screen import — so the
// push/pop/"which screen is live" spine AppController's view-swap rides on is
// unit-testable without a GPU (src/scene/test/overlay-stack.test.ts).
//
// AppController owns the lifecycle calls (start/stop/dispose) around these
// operations; this class owns only the ordering and which entry is current.
// Generalizes the former single `overlay?` slot to depth-N so a modal can sit
// over the system view (the encounter modal, combat plan §2.2) without
// disturbing the depth-1 galaxy↔system/test round-trip.
export class OverlayStack<T> {
  private readonly stack: T[] = [];

  // Number of overlays currently layered over the root.
  get depth(): number {
    return this.stack.length;
  }

  // True when at least one overlay is open. enterOverlay early-returns on this
  // to preserve the original "only one overlay opens from the root" guard.
  get hasOverlay(): boolean {
    return this.stack.length > 0;
  }

  // The live screen: the topmost overlay, or `root` when none is open.
  current(root: T): T {
    return this.stack.at(-1) ?? root;
  }

  push(screen: T): void {
    this.stack.push(screen);
  }

  // Remove and return the topmost overlay (undefined when empty).
  pop(): T | undefined {
    return this.stack.pop();
  }

  // Empty the stack, returning every overlay (bottom-to-top) for teardown.
  clear(): T[] {
    return this.stack.splice(0);
  }
}
