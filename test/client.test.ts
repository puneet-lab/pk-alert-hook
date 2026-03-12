import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlertHook } from '../src/client.js';
import { Severity, type AlertPayload, type AlertProvider } from '../src/types.js';

/** In-memory mock provider that records all payloads */
function createMockProvider(): AlertProvider & { payloads: AlertPayload[] } {
  const payloads: AlertPayload[] = [];
  return {
    name: 'mock',
    payloads,
    async send(payload: AlertPayload) {
      payloads.push(payload);
    },
  };
}

const BASE_CONFIG = {
  webhookUrl: 'https://chat.googleapis.com/v1/spaces/test/messages?key=abc',
  environment: 'production',
  allowedEnvs: ['production', 'staging'],
  appName: 'test-app',
};

describe('AlertHook', () => {
  afterEach(() => {
    AlertHook.destroy();
  });

  // ─── Initialization ──────────────────────────────────────────

  describe('init', () => {
    it('initializes successfully with valid config', () => {
      AlertHook.init(BASE_CONFIG);
      expect(AlertHook.isInitialized()).toBe(true);
    });

    it('throws on invalid config', () => {
      expect(() => AlertHook.init({ webhookUrl: 'not-a-url' } as never)).toThrow();
    });

    it('throws when appName is empty', () => {
      expect(() =>
        AlertHook.init({ ...BASE_CONFIG, appName: '' }),
      ).toThrow();
    });

    it('throws when allowedEnvs is empty', () => {
      expect(() =>
        AlertHook.init({ ...BASE_CONFIG, allowedEnvs: [] }),
      ).toThrow();
    });

    it('throws when webhookUrl does not match google-chat provider prefix', () => {
      expect(() =>
        AlertHook.init({
          ...BASE_CONFIG,
          webhookUrl: 'https://hooks.slack.com/services/xxx',
        }),
      ).toThrow(/must start with.*chat\.googleapis\.com/);
    });

    it('accepts valid google chat webhook URL', () => {
      AlertHook.init({
        ...BASE_CONFIG,
        webhookUrl: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t',
      });
      expect(AlertHook.isInitialized()).toBe(true);
    });
  });

  // ─── capture() ────────────────────────────────────────────────

  describe('capture', () => {
    it('sends error payload to provider', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(BASE_CONFIG, provider);

      AlertHook.capture(new Error('test error'), { userId: 'u1' });
      await AlertHook.flush();

      expect(provider.payloads).toHaveLength(1);
      expect(provider.payloads[0]!.severity).toBe(Severity.ERROR);
      expect(provider.payloads[0]!.message).toBe('test error');
      expect(provider.payloads[0]!.context).toEqual({ userId: 'u1' });
    });

    it('handles string errors', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(BASE_CONFIG, provider);

      AlertHook.capture('string error');
      await AlertHook.flush();

      expect(provider.payloads[0]!.message).toBe('string error');
      expect(provider.payloads[0]!.stack).toBeUndefined();
    });

    it('handles non-error objects', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(BASE_CONFIG, provider);

      AlertHook.capture({ code: 42, reason: 'unknown' });
      await AlertHook.flush();

      expect(provider.payloads[0]!.message).toBe('[object Object]');
    });

    it('does nothing when not initialized (warns only)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      AlertHook.capture(new Error('no init'));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Not initialized'),
      );
      warnSpy.mockRestore();
    });

    it('truncates stack trace to maxStackLength', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider({ ...BASE_CONFIG, maxStackLength: 50 }, provider);

      const longStack = new Error('test');
      longStack.stack = 'a'.repeat(200);
      AlertHook.capture(longStack);
      await AlertHook.flush();

      expect(provider.payloads[0]!.stack!.length).toBeLessThanOrEqual(51); // 50 + ellipsis
    });
  });

  // ─── Environment Filtering ────────────────────────────────────

  describe('environment filtering', () => {
    it('sends alert when environment is in allowedEnvs', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider({ ...BASE_CONFIG, environment: 'production' }, provider);

      AlertHook.capture(new Error('prod error'));
      await AlertHook.flush();

      expect(provider.payloads).toHaveLength(1);
    });

    it('skips alert when environment is NOT in allowedEnvs', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider({ ...BASE_CONFIG, environment: 'development' }, provider);

      AlertHook.capture(new Error('dev error'));
      await AlertHook.flush();

      expect(provider.payloads).toHaveLength(0);
    });
  });

  // ─── alert() ──────────────────────────────────────────────────

  describe('alert', () => {
    it('sends warning by default', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(BASE_CONFIG, provider);

      AlertHook.alert('disk usage at 90%', { disk: '/dev/sda1' });
      await AlertHook.flush();

      expect(provider.payloads[0]!.severity).toBe(Severity.WARNING);
      expect(provider.payloads[0]!.message).toBe('disk usage at 90%');
    });

    it('supports custom severity', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(BASE_CONFIG, provider);

      AlertHook.alert('deploy complete', {}, Severity.INFO);
      await AlertHook.flush();

      expect(provider.payloads[0]!.severity).toBe(Severity.INFO);
    });
  });

  // ─── Global Context ───────────────────────────────────────────

  describe('global context', () => {
    it('merges global context into every payload', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(BASE_CONFIG, provider);

      AlertHook.setGlobalContext({ region: 'us-east-1', service: 'api' });
      AlertHook.capture(new Error('test'), { requestId: 'req-1' });
      await AlertHook.flush();

      expect(provider.payloads[0]!.globalContext).toEqual({
        region: 'us-east-1',
        service: 'api',
      });
      expect(provider.payloads[0]!.context).toEqual({ requestId: 'req-1' });
    });

    it('clearGlobalContext resets context', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(BASE_CONFIG, provider);

      AlertHook.setGlobalContext({ userId: 'u1' });
      AlertHook.clearGlobalContext();
      AlertHook.capture(new Error('test'));
      await AlertHook.flush();

      expect(provider.payloads[0]!.globalContext).toEqual({});
    });
  });

  // ─── Rate Limiting ────────────────────────────────────────────

  describe('rate limiting', () => {
    it('deduplicates identical errors within the window', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(
        { ...BASE_CONFIG, rateLimitWindowMs: 60_000 },
        provider,
      );

      const error = new Error('repeated');
      AlertHook.capture(error);
      AlertHook.capture(error);
      AlertHook.capture(error);
      await AlertHook.flush();

      // Only first one should be sent
      expect(provider.payloads).toHaveLength(1);
      expect(provider.payloads[0]!.occurrences).toBe(1);
    });

    it('allows different errors through', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(BASE_CONFIG, provider);

      AlertHook.capture(new Error('error A'));
      AlertHook.capture(new Error('error B'));
      await AlertHook.flush();

      expect(provider.payloads).toHaveLength(2);
    });

    it('sends all when rate limiting is disabled', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(
        { ...BASE_CONFIG, rateLimitEnabled: false },
        provider,
      );

      const error = new Error('repeated');
      AlertHook.capture(error);
      AlertHook.capture(error);
      AlertHook.capture(error);
      await AlertHook.flush();

      expect(provider.payloads).toHaveLength(3);
    });
  });

  // ─── Google Chat rate limit (50/min) ────────────────────────────

  describe('global send throttle', () => {
    it('drops alerts after 50 sends per minute', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(
        { ...BASE_CONFIG, rateLimitEnabled: false },
        provider,
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Send 55 unique errors
      for (let i = 0; i < 55; i++) {
        AlertHook.capture(new Error(`error-${i}`));
      }
      await AlertHook.flush();

      // Only 50 should have been sent
      expect(provider.payloads).toHaveLength(50);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Throttled'),
      );

      warnSpy.mockRestore();
    });

    it('allows sends again after the minute window passes', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(
        { ...BASE_CONFIG, rateLimitEnabled: false },
        provider,
      );

      vi.useFakeTimers();

      // Exhaust the limit
      for (let i = 0; i < 50; i++) {
        AlertHook.capture(new Error(`batch1-${i}`));
      }

      // This should be dropped
      AlertHook.capture(new Error('dropped'));
      expect(provider.payloads).toHaveLength(50);

      // Advance past the 60s window
      vi.advanceTimersByTime(61_000);

      // Should work again
      AlertHook.capture(new Error('after-window'));
      await AlertHook.flush();

      expect(provider.payloads).toHaveLength(51);
      expect(provider.payloads[50]!.message).toBe('after-window');

      vi.useRealTimers();
    });
  });

  // ─── Provider failure handling ────────────────────────────────

  describe('provider failure', () => {
    it('does not throw when provider fails (fire-and-forget)', async () => {
      const failingProvider: AlertProvider = {
        name: 'failing',
        async send() {
          throw new Error('webhook down');
        },
      };

      AlertHook.initWithProvider(BASE_CONFIG, failingProvider);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should not throw
      AlertHook.capture(new Error('test'));
      await AlertHook.flush();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send alert'),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });

    it('suppresses console warning in silent mode', async () => {
      const failingProvider: AlertProvider = {
        name: 'failing',
        async send() {
          throw new Error('webhook down');
        },
      };

      AlertHook.initWithProvider({ ...BASE_CONFIG, silent: true }, failingProvider);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      AlertHook.capture(new Error('test'));
      await AlertHook.flush();

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ─── Timezone ─────────────────────────────────────────────────

  describe('timezone', () => {
    it('uses configured timezone in timestamp', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider({ ...BASE_CONFIG, timezone: 'Asia/Karachi' }, provider);

      AlertHook.capture(new Error('tz test'));
      await AlertHook.flush();

      // PKT = Pakistan Standard Time
      expect(provider.payloads[0]!.timestamp).toMatch(/PKT|GMT\+5/);
    });

    it('defaults to UTC', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(BASE_CONFIG, provider);

      AlertHook.capture(new Error('utc test'));
      await AlertHook.flush();

      expect(provider.payloads[0]!.timestamp).toContain('UTC');
    });

    it('falls back to ISO string on invalid timezone', async () => {
      const provider = createMockProvider();
      AlertHook.initWithProvider(
        { ...BASE_CONFIG, timezone: 'Invalid/Zone' },
        provider,
      );

      AlertHook.capture(new Error('bad tz'));
      await AlertHook.flush();

      // ISO format fallback
      expect(provider.payloads[0]!.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
  });

  // ─── Never breaks user code ───────────────────────────────────

  describe('never breaks user code', () => {
    it('capture() never throws even if provider.send throws synchronously', () => {
      const bombProvider: AlertProvider = {
        name: 'bomb',
        send(): Promise<void> {
          throw new Error('sync explosion in provider');
        },
      };

      AlertHook.initWithProvider(BASE_CONFIG, bombProvider);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => AlertHook.capture(new Error('test'))).not.toThrow();

      warnSpy.mockRestore();
    });

    it('alert() never throws even with corrupted internal state', () => {
      AlertHook.init(BASE_CONFIG);
      // Corrupt internal state by forcing rateLimiter to throw
      const instance = (AlertHook as unknown as Record<string, unknown>).instance as Record<string, unknown>;
      instance.rateLimiter = { check: () => { throw new Error('corrupted'); }, destroy: () => {} };

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => AlertHook.alert('test')).not.toThrow();

      warnSpy.mockRestore();
    });

    it('setGlobalContext() never throws', () => {
      AlertHook.destroy(); // no instance
      expect(() => AlertHook.setGlobalContext({ foo: 'bar' })).not.toThrow();
    });

    it('clearGlobalContext() never throws', () => {
      AlertHook.destroy();
      expect(() => AlertHook.clearGlobalContext()).not.toThrow();
    });

    it('flush() never throws', async () => {
      AlertHook.destroy();
      await expect(AlertHook.flush()).resolves.toBeUndefined();
    });

    it('destroy() never throws', () => {
      AlertHook.destroy();
      expect(() => AlertHook.destroy()).not.toThrow();
    });

    it('capture() with null/undefined args never throws', () => {
      AlertHook.init(BASE_CONFIG);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => AlertHook.capture(null)).not.toThrow();
      expect(() => AlertHook.capture(undefined)).not.toThrow();
      expect(() => AlertHook.capture(0)).not.toThrow();
      expect(() => AlertHook.capture('')).not.toThrow();

      warnSpy.mockRestore();
    });
  });
});
