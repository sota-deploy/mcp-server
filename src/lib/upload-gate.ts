/**
 * A small counting gate for memory-heavy work: large request bodies on the
 * hosted server and the archive build + upload of a deploy. A 10 MB inline
 * deploy (13+ MB of base64 JSON) costs tens of MB while it is parsed,
 * decoded and packed; the hosted container has 512 MB. Two at a time keep
 * the peak bounded; the next caller gets a clear "busy, retry" answer
 * instead of the process running out of memory for everyone.
 */
export class Gate {
  private active = 0;
  constructor(readonly limit: number) {}

  /** A release function, or null when the gate is full. */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }

  get inUse(): number {
    return this.active;
  }
}

/** Deploy archive builds + uploads at the same time (per process). */
export const DEPLOY_UPLOADS = new Gate(2);
/** Large hosted request bodies being read and parsed at the same time. */
export const LARGE_BODIES = new Gate(2);
/** What a refused caller is told to wait. */
export const BUSY_RETRY_SECONDS = 15;
