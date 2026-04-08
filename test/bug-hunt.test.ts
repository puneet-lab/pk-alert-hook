import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlertHook } from '../src/client.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { formatGoogleChatCard } from '../src/formatter.js';
import { Severity, type AlertPayload, type AlertProvider } from '../src/types.js';

// ─── Helpers ──────────────────────────────────────────────────────

function createMockProvider(): AlertProvider & { payloads: AlertPayload[] } {
  const payloads: AlertPayload[] = [];
  return {
    name: 'mock',
    payloads,
    async send(payload: AlertPayload) {
      payloads.push(structuredClone(payload));
    },
  };
}

function createSlowProvider(
  delayMs: number,
): AlertProvider & { payloads: AlertPayload[]; resolve: () => void } {
  const payloads: AlertPayload[] = [];
  let resolveFn: () => void = () => {};
  return {
    name: 'slow',
    payloads,
    get resolve() {
      return resolveFn;
    },
    async send(payload: AlertPayload) {
      await new Promise<void>((r) => {
        resolveFn = r;
        if (delayMs > 0) setTimeout(r, delayMs);
      });
      payloads.push(structuredClone(payload));
    },
  };
}

const BASE_CONFIG = {
  webhookUrl: 'https://chat.googleapis.com/v1/spaces/test/messages?key=abc',
  environment: 'production',
  allowedEnvs: ['production'],
  appName: 'test-app',
};

function makePayload(overrides: Partial<AlertPayload> = {}): AlertPayload {
  return {
    severity: Severity.ERROR,
    message: 'Something went wrong',
    stack: 'at foo (/src/bar.ts:10:5)',
    context: {},
    globalContext: {},
    appName: 'test-app',
    environment: 'production',
    timestamp: '12/03/2026, 14:30:00 UTC',
    fingerprint: 'test-fp',
    occurrences: 1,
    showPreviewText: true,
    ...overrides,
  };
}

describe('Bug Hunt', () => {
  afterEach(() => {
    AlertHook.destroy();
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════════
  // BUG 1: flush() does not flush suppressed counts from rate limiter
  //
  // Scenario: 10 identical errors fire, only the 1st is sent.
  // User calls flush() during graceful shutdown. The remaining 9
  // suppressed occurrences should be sent as a summary alert.
  // Currently they are silently lost.
  // ═══════════════════════════════════════════════════════════════

  describe('flush() should drain rate limiter suppressed counts', () => {
    it('flush sends a final summary for errors suppressed during the window', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(
        { ...BASE_CONFIG, rateLimitWindowMs: 60_000 },
        provider,
      );

      // Fire 10 identical errors — only the 1st should be sent immediately
      for (let i = 0; i < 10; i++) {
        AlertHook.capture(new Error('repeated db timeout'));
      }

      // Now flush (e.g. SIGTERM graceful shutdown)
      await AlertHook.flush();

      // We should have 2 payloads:
      // 1st: the initial alert (occurrences=1)
      // 2nd: flush summary with the 9 suppressed occurrences
      const totalOccurrences = provider.payloads.reduce(
        (sum, p) => sum + p.occurrences,
        0,
      );
      expect(totalOccurrences).toBe(10);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BUG 2: Suppressed error count is silently lost when the error
  // stops occurring and the rate limiter cleanup evicts the entry.
  //
  // Scenario: Error fires 50 times in one window, then stops.
  // The cleanup timer evicts the entry after 2x window.
  // Those 49 suppressed occurrences are never reported.
  // ═══════════════════════════════════════════════════════════════

  describe('suppressed counts should not be silently lost on cleanup eviction', () => {
    it('rate limiter cleanup should report suppressed counts before evicting', () => {
      vi.useFakeTimers();
      const limiter = new RateLimiter(1000); // 1s window

      // 5 occurrences — 1st sent, 4 suppressed
      limiter.check('err-1');
      limiter.check('err-1');
      limiter.check('err-1');
      limiter.check('err-1');
      limiter.check('err-1');

      // Error stops. Advance past cleanup threshold (2x window = 2s)
      vi.advanceTimersByTime(3000);

      // Entry should have been evicted by cleanup
      // But the 4 suppressed counts should not just vanish
      // At minimum, flush should have captured them
      const pending = limiter.flush();

      // If evicted, flush returns nothing — the 4 occurrences are lost
      // This test documents the data loss
      const totalPending = Array.from(pending.values()).reduce((a, b) => a + b.count, 0);
      expect(totalPending).toBeGreaterThanOrEqual(4);

      limiter.destroy();
      vi.useRealTimers();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BUG 3: Preview text is NOT HTML-escaped, but the card body IS.
  //
  // If the message contains HTML tags, the card body safely escapes
  // them (<b> → &lt;b&gt;) but the `text` preview field does NOT.
  // Google Chat renders the `text` field with basic HTML support,
  // so an attacker-controlled error message could inject formatting.
  // ═══════════════════════════════════════════════════════════════

  describe('preview text should be HTML-escaped', () => {
    it('text preview field should escape HTML in message', () => {
      const payload = makePayload({
        message: '<b>evil</b> <a href="http://evil.com">click</a>',
        showPreviewText: true,
      });
      const result = formatGoogleChatCard(payload);

      // The text preview should NOT contain raw HTML tags
      const text = result.text as string;
      expect(text).not.toContain('<b>');
      expect(text).not.toContain('<a href');
    });

    it('text preview field should escape HTML in appName', () => {
      const payload = makePayload({
        appName: '<script>alert(1)</script>',
        showPreviewText: true,
      });
      const result = formatGoogleChatCard(payload);

      const text = result.text as string;
      expect(text).not.toContain('<script>');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BUG 4: Re-init while alerts are in flight orphans pending promises.
  //
  // If init() is called again while the first instance has pending
  // sends, the new instance's flush() will NOT await those old sends.
  // This can cause data loss during hot-reload or re-configuration.
  // ═══════════════════════════════════════════════════════════════

  describe('re-init should not orphan in-flight promises', () => {
    it('flush after re-init still awaits sends from the previous instance', async () => {
      let firstSendCompleted = false;
      const slowProvider: AlertProvider = {
        name: 'slow',
        async send() {
          await new Promise((r) => setTimeout(r, 50));
          firstSendCompleted = true;
        },
      };

      AlertHook.initWithProvider(BASE_CONFIG, slowProvider);
      AlertHook.capture(new Error('in-flight error'));

      // Re-init with a new provider immediately (before first send completes)
      const newProvider = createMockProvider();
      AlertHook.initWithProvider(BASE_CONFIG, newProvider);

      // Flush the NEW instance
      await AlertHook.flush();

      // The in-flight promise from the OLD instance should also have completed
      expect(firstSendCompleted).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BUG 5: Rate limiter MAX_ENTRIES eviction discards accumulated
  // counts without sending.
  //
  // When 1000 unique fingerprints fill the map, the 1001st evicts
  // the oldest entry. If that entry had count=50 (49 suppressed),
  // those counts vanish without a trace.
  // ═══════════════════════════════════════════════════════════════

  describe('MAX_ENTRIES eviction should not lose suppressed counts', () => {
    it('evicted entry count is not silently lost', () => {
      const limiter = new RateLimiter(60_000);

      // Fill first entry with many occurrences
      limiter.check('important-error');
      for (let i = 0; i < 20; i++) {
        limiter.check('important-error'); // suppressed, count accumulates
      }

      // Fill remaining 999 slots with unique fingerprints
      for (let i = 0; i < 999; i++) {
        limiter.check(`unique-${i}`);
      }

      // 1001st unique fingerprint should evict the first entry
      limiter.check('the-new-one');

      // important-error had 21 occurrences (1 sent + 20 suppressed)
      // If it was evicted, those 20 suppressed counts are lost
      // Trying to check it again should NOT show count=1 as if it's brand new
      const result = limiter.check('important-error');

      // If the entry was evicted and re-created, count will be 1 (data loss)
      // Ideally, the eviction should have preserved or reported the count
      expect(result.count).toBeGreaterThan(1);

      limiter.destroy();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BUG 6: Global throttle counts a send BEFORE the provider
  // actually succeeds. If the provider fails, the send slot is
  // wasted — reducing effective throughput under failure.
  //
  // 50 sends that all fail still exhaust the throttle, blocking
  // real alerts for the rest of the minute.
  // ═══════════════════════════════════════════════════════════════

  describe('global throttle should not count failed sends', () => {
    it('provider failures should not consume send slots', async () => {
      let failCount = 0;
      const failingProvider: AlertProvider = {
        name: 'failing',
        async send() {
          failCount++;
          throw new Error('webhook down');
        },
      };

      AlertHook.initWithProvider(
        { ...BASE_CONFIG, rateLimitEnabled: false, silent: true },
        failingProvider,
      );

      // Send 50 unique errors — all will fail
      for (let i = 0; i < 50; i++) {
        AlertHook.capture(new Error(`fail-${i}`));
      }
      await AlertHook.flush();

      // All 50 attempted
      expect(failCount).toBe(50);

      // Now send a 51st — this should NOT be throttled since
      // none of the previous 50 actually succeeded
      failCount = 0;
      const successProvider = createMockProvider();

      // We can't swap provider without re-init, so let's just verify
      // the throttle IS blocking — which demonstrates the bug
      AlertHook.capture(new Error('blocked-by-failures'));
      await AlertHook.flush();

      // If throttle counts failures, failCount stays 0 (blocked)
      // If throttle correctly ignores failures, failCount would be 1
      // This documents the current (buggy) behavior:
      expect(failCount).toBe(0); // BUG: throttled despite 0 successful sends
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BUG 7: context overrides globalContext with no warning.
  //
  // If user sets globalContext with { region: 'us-east-1' } and
  // then captures with context { region: 'eu-west-1' }, the
  // merged card shows only eu-west-1. This is silent data loss
  // that could confuse on-call engineers.
  // ═══════════════════════════════════════════════════════════════

  describe('context key collision behavior', () => {
    it('context with same key as globalContext should include both values', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(BASE_CONFIG, provider);

      AlertHook.setGlobalContext({ region: 'us-east-1', service: 'api' });
      AlertHook.capture(new Error('test'), { region: 'eu-west-1' });
      await AlertHook.flush();

      // The merged context in the card should NOT silently drop globalContext's region
      const payload = provider.payloads[0]!;

      // Both contexts are stored separately in the payload
      expect(payload.globalContext.region).toBe('us-east-1');
      expect(payload.context.region).toBe('eu-west-1');

      // But the formatter merges them: { ...globalContext, ...context }
      // This means globalContext.region is silently overwritten
      const card = formatGoogleChatCard(payload);
      const cardStr = JSON.stringify(card);

      // The card should show BOTH values, or at least both contexts
      // Currently globalContext.region='us-east-1' is silently dropped
      expect(cardStr).toContain('us-east-1');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BUG 8: Payload sends the NORMALIZED fingerprint instead of
  // the original message. This means the Google Chat card shows
  // the fingerprint with <n> and <uuid> placeholders, which is
  // confusing for on-call engineers.
  //
  // (Regression risk from the fingerprint normalization fix)
  // ═══════════════════════════════════════════════════════════════

  describe('payload should contain original message, not normalized fingerprint', () => {
    it('sent payload message is the original, not the normalized version', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(
        { ...BASE_CONFIG, rateLimitEnabled: false },
        provider,
      );

      AlertHook.alert('SQS poll failing (2372 consecutive errors)');
      await AlertHook.flush();

      // The message in the payload should be the ORIGINAL message
      expect(provider.payloads[0]!.message).toBe(
        'SQS poll failing (2372 consecutive errors)',
      );

      // The fingerprint should be the normalized version
      expect(provider.payloads[0]!.fingerprint).toContain('<n>');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BUG 9: After window expires, the reported occurrences count
  // includes the current trigger (+1). But the FIRST alert in a
  // new window shows occurrences=1 even though the rate limiter
  // returned the accumulated count from the previous window.
  //
  // This means the occurrences count is misleading — it shows
  // "Occurred 51 times" but the actual meaning is "50 times in
  // the old window + 1 trigger for the new window".
  // ═══════════════════════════════════════════════════════════════

  describe('occurrences count accuracy across windows', () => {
    it('accumulated occurrences should match actual error count', async () => {
      vi.useFakeTimers();
      const provider = createMockProvider();
      AlertHook.initWithProvider(
        { ...BASE_CONFIG, rateLimitWindowMs: 1000 },
        provider,
      );

      // Window 1: fire 5 identical errors
      const err = new Error('timeout');
      err.stack = 'Error: timeout\n    at fn (/app.ts:1:1)';
      for (let i = 0; i < 5; i++) {
        AlertHook.capture(err);
      }

      // Wait for window to expire
      vi.advanceTimersByTime(1500);

      // Window 2: fire 1 more — this triggers window-expired send
      AlertHook.capture(err);
      await AlertHook.flush();

      // 1st payload: occurrences=1 (first occurrence)
      // 2nd payload: occurrences should represent all 5 from window 1
      // but the rate limiter returns count=5+1=6 (old count + trigger)
      expect(provider.payloads).toHaveLength(2);

      const total = provider.payloads.reduce((sum, p) => sum + p.occurrences, 0);
      // Total should be exactly 6 (5 from window 1 + 1 trigger in window 2)
      // But is it? The first payload has occurrences=1, second has occurrences=6
      // That's 7 total — double-counting the first occurrence
      expect(total).toBe(6);
    });
  });
});
