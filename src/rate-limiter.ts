interface RateLimitEntry {
  count: number;
  firstSeen: number;
  lastSeen: number;
}

/**
 * Fingerprint-based rate limiter to prevent webhook flooding.
 *
 * Groups identical errors (same fingerprint) within a time window.
 * Returns the accumulated count so the alert can show "occurred N times".
 */
const MAX_ENTRIES = 1000;

export class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly windowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
    this.startCleanup();
  }

  /**
   * Check if this fingerprint should be sent.
   * Returns `{ shouldSend: true, count }` if the window expired or first occurrence.
   * Returns `{ shouldSend: false }` if still within the dedup window.
   */
  check(fingerprint: string): { shouldSend: boolean; count: number } {
    const now = Date.now();
    const existing = this.entries.get(fingerprint);

    if (!existing) {
      // Hard cap: evict oldest entry if at limit
      if (this.entries.size >= MAX_ENTRIES) {
        const oldestKey = this.entries.keys().next().value!;
        this.entries.delete(oldestKey);
      }
      this.entries.set(fingerprint, { count: 1, firstSeen: now, lastSeen: now });
      return { shouldSend: true, count: 1 };
    }

    const windowExpired = now - existing.firstSeen >= this.windowMs;

    if (windowExpired) {
      const totalCount = existing.count + 1;
      this.entries.set(fingerprint, { count: 1, firstSeen: now, lastSeen: now });
      return { shouldSend: true, count: totalCount };
    }

    existing.count++;
    existing.lastSeen = now;
    return { shouldSend: false, count: existing.count };
  }

  /** Remove stale entries older than 2x the window */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const staleThreshold = this.windowMs * 2;

      for (const [key, entry] of this.entries) {
        if (now - entry.lastSeen > staleThreshold) {
          this.entries.delete(key);
        }
      }
    }, this.windowMs);

    // Unref so this timer doesn't prevent process exit
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /** Flush all pending counts and return them for final send */
  flush(): Map<string, number> {
    const pending = new Map<string, number>();

    for (const [key, entry] of this.entries) {
      if (entry.count > 1) {
        pending.set(key, entry.count);
      }
    }

    this.entries.clear();
    return pending;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
