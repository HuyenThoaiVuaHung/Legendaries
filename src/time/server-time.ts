/**
 * Monotonic clock plus a boot-anchored epoch, so deadlines never jump with
 * wall-clock adjustments but can still be shown to clients as epoch ms.
 */
export class ServerTime {
  private readonly bootMono = performance.now();
  private readonly bootEpoch = Date.now();

  /** Milliseconds on the monotonic clock. */
  mono(): number {
    return performance.now();
  }

  /** Epoch ms for a monotonic instant (now by default). */
  epoch(mono: number = this.mono()): number {
    return Math.round(this.bootEpoch + (mono - this.bootMono));
  }

  /** Run `fn` at a monotonic instant; returns a cancel function. */
  schedule(atMono: number, fn: () => void): () => void {
    const handle = setTimeout(fn, Math.max(0, atMono - this.mono()));
    return () => clearTimeout(handle);
  }
}

/** Process-wide instance shared by rooms so every deadline uses one anchor. */
export const defaultServerTime = new ServerTime();
