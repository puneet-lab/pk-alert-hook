import { GoogleChatProvider } from './providers/google-chat.js';
import { RateLimiter } from './rate-limiter.js';
import {
  type AlertHookConfig,
  type AlertPayload,
  type AlertProvider,
  type ResolvedConfig,
  Severity,
  ProviderName,
  configSchema,
  baseConfigSchema,
} from './types.js';

/**
 * AlertHook — lightweight error alerting to Google Chat (and more).
 *
 * Usage:
 *   AlertHook.init({ webhookUrl, environment, allowedEnvs, appName });
 *   AlertHook.capture(error, { userId });
 */
export class AlertHook {
  private static instance: AlertHook | null = null;

  private readonly config: ResolvedConfig;
  private readonly provider: AlertProvider;
  private readonly rateLimiter: RateLimiter | null;
  private globalContext: Record<string, unknown> = {};
  private pendingPromises: Promise<void>[] = [];

  /** Google Chat enforces 60 msgs/min — we cap at 50 with buffer */
  private static readonly MAX_SENDS_PER_MINUTE = 50;
  private sendTimestamps: number[] = [];
  private droppedCount = 0;

  private constructor(config: ResolvedConfig, provider: AlertProvider) {
    this.config = config;
    this.rateLimiter = config.rateLimitEnabled
      ? new RateLimiter(config.rateLimitWindowMs)
      : null;
    this.provider = provider;
  }

  // ─── Static API ────────────────────────────────────────────────

  /**
   * Initialize AlertHook. Must be called once at application startup.
   * Validates config with Zod — throws on invalid config.
   */
  static init(config: AlertHookConfig): void {
    AlertHook.instance?.rateLimiter?.destroy();
    const parsed = configSchema.parse(config);
    const provider = AlertHook.createProvider(parsed);
    AlertHook.instance = new AlertHook(parsed, provider);
  }

  /**
   * Initialize with a custom provider (for extensibility or testing).
   * Skips provider-specific webhook URL validation — you own the provider.
   */
  static initWithProvider(config: AlertHookConfig, provider: AlertProvider): void {
    AlertHook.instance?.rateLimiter?.destroy();
    const parsed = baseConfigSchema.parse(config);
    AlertHook.instance = new AlertHook(parsed, provider);
  }

  /**
   * Capture an error and send alert if environment is allowed.
   * Fire-and-forget by default — never throws, never blocks.
   */
  static capture(error: unknown, context: Record<string, unknown> = {}): void {
    try {
      const instance = AlertHook.getInstance();
      if (!instance) return;

      const { message, stack } = AlertHook.normalizeError(error);
      instance.sendAlert(Severity.ERROR, message, stack, context);
    } catch (err) {
      AlertHook.safeWarn('capture() failed', err);
    }
  }

  /**
   * Send a manual warning/info alert.
   */
  static alert(
    message: string,
    context: Record<string, unknown> = {},
    severity: Severity = Severity.WARNING,
  ): void {
    try {
      const instance = AlertHook.getInstance();
      if (!instance) return;

      instance.sendAlert(severity, message, undefined, context);
    } catch (err) {
      AlertHook.safeWarn('alert() failed', err);
    }
  }

  /**
   * Set persistent global context (e.g. userId after login).
   * Merged into every subsequent alert.
   */
  static setGlobalContext(context: Record<string, unknown>): void {
    try {
      const instance = AlertHook.getInstance();
      if (!instance) return;

      instance.globalContext = { ...instance.globalContext, ...context };
    } catch (err) {
      AlertHook.safeWarn('setGlobalContext() failed', err);
    }
  }

  /**
   * Clear all global context.
   */
  static clearGlobalContext(): void {
    try {
      const instance = AlertHook.getInstance();
      if (!instance) return;

      instance.globalContext = {};
    } catch (err) {
      AlertHook.safeWarn('clearGlobalContext() failed', err);
    }
  }

  /**
   * Await all pending alert sends. Call during graceful shutdown.
   */
  static async flush(): Promise<void> {
    try {
      const instance = AlertHook.getInstance();
      if (!instance) return;

      await Promise.allSettled(instance.pendingPromises);
      instance.pendingPromises = [];
    } catch (err) {
      AlertHook.safeWarn('flush() failed', err);
    }
  }

  /**
   * Tear down the instance. Stops rate limiter, clears state.
   */
  static destroy(): void {
    try {
      if (AlertHook.instance) {
        AlertHook.instance.rateLimiter?.destroy();
        AlertHook.instance = null;
      }
    } catch (err) {
      AlertHook.safeWarn('destroy() failed', err);
      AlertHook.instance = null;
    }
  }

  /**
   * Check if AlertHook has been initialized.
   */
  static isInitialized(): boolean {
    return AlertHook.instance !== null;
  }

  // ─── Internal ──────────────────────────────────────────────────

  /**
   * Safe console.warn that never throws — last line of defense.
   * Respects silent mode when instance is available.
   */
  private static safeWarn(message: string, err: unknown): void {
    try {
      const isSilent = AlertHook.instance?.config.silent ?? false;
      if (!isSilent) {
        console.warn(`[pk-alert-hook] ${message}:`, err);
      }
    } catch {
      // Absolute last resort — swallow everything
    }
  }

  private static getInstance(): AlertHook | null {
    if (!AlertHook.instance) {
      console.warn('[pk-alert-hook] Not initialized. Call AlertHook.init() first.');
      return null;
    }
    return AlertHook.instance;
  }

  private static createProvider(config: ResolvedConfig): AlertProvider {
    switch (config.provider) {
      case ProviderName.GOOGLE_CHAT:
        return new GoogleChatProvider(config.webhookUrl);
      default: {
        const _exhaustive: never = config.provider;
        throw new Error(`Unknown provider: ${_exhaustive}`);
      }
    }
  }

  private static normalizeError(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
      return { message: error.message, stack: error.stack };
    }

    if (typeof error === 'string') {
      return { message: error };
    }

    return { message: String(error) };
  }

  private isEnvironmentAllowed(): boolean {
    return this.config.allowedEnvs.includes(this.config.environment);
  }

  private formatTimestamp(): string {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: this.config.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'short',
      }).format(new Date());
    } catch {
      // Fallback if invalid timezone
      return new Date().toISOString();
    }
  }

  private truncateStack(stack?: string): string | undefined {
    if (!stack) return undefined;
    if (stack.length <= this.config.maxStackLength) return stack;
    return stack.slice(0, this.config.maxStackLength) + '…';
  }

  /**
   * Token bucket: allow up to MAX_SENDS_PER_MINUTE sends in a rolling 60s window.
   * Evicts timestamps older than 60s, then checks if under limit.
   */
  private canSend(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    // Evict old timestamps
    this.sendTimestamps = this.sendTimestamps.filter((ts) => ts > oneMinuteAgo);

    if (this.sendTimestamps.length >= AlertHook.MAX_SENDS_PER_MINUTE) {
      return false;
    }

    this.sendTimestamps.push(now);
    this.droppedCount = 0; // Reset on successful send
    return true;
  }

  private createFingerprint(message: string, stack?: string): string {
    // Use message + first line of stack for dedup
    const firstFrame = stack?.split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
    return `${message}::${firstFrame.trim()}`;
  }

  private sendAlert(
    severity: Severity,
    message: string,
    stack: string | undefined,
    context: Record<string, unknown>,
  ): void {
    if (!this.isEnvironmentAllowed()) return;

    const fingerprint = this.createFingerprint(message, stack);

    let occurrences = 1;
    if (this.rateLimiter) {
      const result = this.rateLimiter.check(fingerprint);
      if (!result.shouldSend) return;
      occurrences = result.count;
    }

    // ── Global send throttle (Google Chat: 60/min, we cap at 50) ──
    if (!this.canSend()) {
      this.droppedCount++;
      if (!this.config.silent) {
        console.warn(
          `[pk-alert-hook] Throttled — ${this.droppedCount} alert(s) dropped this minute (Google Chat limit: 60/min).`,
        );
      }
      return;
    }

    const payload: AlertPayload = {
      severity,
      message,
      stack: this.truncateStack(stack),
      context,
      globalContext: { ...this.globalContext },
      appName: this.config.appName,
      environment: this.config.environment,
      version: this.config.version,
      timestamp: this.formatTimestamp(),
      fingerprint,
      occurrences,
      showPreviewText: this.config.showPreviewText,
    };

    const promise = this.provider.send(payload).catch((err) => {
      if (!this.config.silent) {
        console.warn(`[pk-alert-hook] Failed to send alert via ${this.provider.name}:`, err);
      }
    });

    this.pendingPromises.push(promise);

    // Self-clean: remove from array once resolved (no stale references)
    promise.then(() => {
      const idx = this.pendingPromises.indexOf(promise);
      if (idx !== -1) this.pendingPromises.splice(idx, 1);
    });
  }
}
