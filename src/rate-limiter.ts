interface RateLimitEntry {
  count: number;
  pendingCount: number;
  firstSeen: number;
  lastSeen: number;
  metadata?: unknown;
}

export interface FlushEntry {
  count: number;
  metadata?: unknown;
}

/**
 * Fingerprint-based rate limiter to prevent webhook flooding.
 *
 * Groups identical errors (same fingerprint) within a time window.
 * Returns the accumulated count so the alert can show "occurred N times".
 *
 * Callers MUST call `confirmSend(fingerprint)` after successfully sending
 * an alert so the limiter can track which occurrences were reported.
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
   *
   * `metadata` is stored alongside the entry and returned by `flush()` so
   * the caller can reconstruct a meaningful alert during graceful shutdown.
   */
  check(fingerprint: string, metadata?: unknown): { shouldSend: boolean; count: number } {
    const now = Date.now();
    const existing = this.entries.get(fingerprint);

    if (!existing) {
      // Hard cap: evict lowest-value entry if at limit
      if (this.entries.size >= MAX_ENTRIES) {
        this.evictOne();
      }
      this.entries.set(fingerprint, {
        count: 1,
        pendingCount: 1,
        firstSeen: now,
        lastSeen: now,
        metadata,
      });
      return { shouldSend: true, count: 1 };
    }

    const windowExpired = now - existing.firstSeen >= this.windowMs;

    if (windowExpired) {
      // pending from old window + 1 for the current trigger
      const totalPending = existing.pendingCount + 1;
      this.entries.set(fingerprint, {
        count: 1,
        pendingCount: 1,
        firstSeen: now,
        lastSeen: now,
        metadata: metadata ?? existing.metadata,
      });
      return { shouldSend: true, count: totalPending };
    }

    existing.count++;
    existing.pendingCount++;
    existing.lastSeen = now;
    if (metadata !== undefined) existing.metadata = metadata;
    return { shouldSend: false, count: existing.count };
  }

  /**
   * Mark a fingerprint's pending count as reported.
   * Call this AFTER the alert is actually queued for delivery.
   */
  confirmSend(fingerprint: string): void {
    const entry = this.entries.get(fingerprint);
    if (entry) entry.pendingCount = 0;
  }

  /**
   * Evict one entry to make room. Prefers entries with no pending
   * counts (already reported). Falls back to the entry with the
   * lowest pending count to minimise data loss.
   */
  private evictOne(): void {
    let targetKey: string | null = null;
    let lowestPending = Infinity;

    for (const [key, entry] of this.entries) {
      if (entry.pendingCount === 0) {
        targetKey = key;
        break; // Best candidate — already fully reported
      }
      if (entry.pendingCount < lowestPending) {
        lowestPending = entry.pendingCount;
        targetKey = key;
      }
    }

    if (targetKey) {
      this.entries.delete(targetKey);
    }
  }

  /** Remove stale entries older than 2x the window (only if fully reported) */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const staleThreshold = this.windowMs * 2;

      for (const [key, entry] of this.entries) {
        if (now - entry.lastSeen > staleThreshold && entry.pendingCount === 0) {
          this.entries.delete(key);
        }
      }
    }, this.windowMs);

    // Unref so this timer doesn't prevent process exit
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /** Flush all entries with unreported counts, for graceful shutdown. */
  flush(): Map<string, FlushEntry> {
    const pending = new Map<string, FlushEntry>();

    for (const [key, entry] of this.entries) {
      if (entry.pendingCount > 0) {
        pending.set(key, { count: entry.pendingCount, metadata: entry.metadata });
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
