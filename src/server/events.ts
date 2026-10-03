import type { RuntimeEvent } from '../shared/types.js';

export class EventHub {
  cursor = 0;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  publish(type: RuntimeEvent['type'], data: unknown): void {
    const event = { cursor: ++this.cursor, type, data };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
