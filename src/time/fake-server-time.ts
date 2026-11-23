import { ServerTime } from './server-time';

interface Scheduled {
  at: number;
  order: number;
  fn: () => void;
}

/** Manually advanced clock for tests; due callbacks fire in time order. */
export class FakeServerTime extends ServerTime {
  private now = 0;
  private order = 0;
  private readonly queue = new Set<Scheduled>();

  constructor(private readonly epochAtZero = 1_700_000_000_000) {
    super();
  }

  override mono(): number {
    return this.now;
  }

  override epoch(mono: number = this.now): number {
    return Math.round(this.epochAtZero + mono);
  }

  override schedule(atMono: number, fn: () => void): () => void {
    const entry: Scheduled = { at: atMono, order: this.order++, fn };
    this.queue.add(entry);
    return () => {
      this.queue.delete(entry);
    };
  }

  /** Number of callbacks still waiting. */
  pending(): number {
    return this.queue.size;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let next: Scheduled | undefined;
      for (const entry of this.queue) {
        if (entry.at > target) continue;
        if (!next || entry.at < next.at || (entry.at === next.at && entry.order < next.order)) next = entry;
      }
      if (!next) break;
      this.queue.delete(next);
      this.now = Math.max(this.now, next.at);
      next.fn();
    }
    this.now = target;
  }
}
