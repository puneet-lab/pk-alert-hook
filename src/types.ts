import { z } from 'zod';

// ─── Provider Types ──────────────────────────────────────────────

export const ProviderName = {
  GOOGLE_CHAT: 'google-chat',
} as const;

export type ProviderName = (typeof ProviderName)[keyof typeof ProviderName];

export const providerNameSchema = z.enum([ProviderName.GOOGLE_CHAT]);

// ─── Provider Webhook URL Prefixes ───────────────────────────────

const PROVIDER_WEBHOOK_PREFIXES: Record<ProviderName, string> = {
  [ProviderName.GOOGLE_CHAT]: 'https://chat.googleapis.com/',
};

// ─── Severity ────────────────────────────────────────────────────

export const Severity = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
} as const;

export type Severity = (typeof Severity)[keyof typeof Severity];

export const severitySchema = z.enum([Severity.ERROR, Severity.WARNING, Severity.INFO]);

// ─── Config Schema ───────────────────────────────────────────────

/** Base schema — validates structure only, no provider-specific checks */
export const baseConfigSchema = z.object({
  webhookUrl: z.string().url('webhookUrl must be a valid URL'),
  provider: providerNameSchema.default(ProviderName.GOOGLE_CHAT),
  environment: z.string().min(1, 'environment is required'),
  allowedEnvs: z.array(z.string()).min(1, 'at least one allowedEnv is required'),
  appName: z.string().min(1, 'appName is required'),
  version: z.string().optional(),
  maxStackLength: z.number().int().positive().default(500),
  timezone: z.string().default('UTC'),
  rateLimitWindowMs: z.number().int().positive().default(300_000),
  rateLimitEnabled: z.boolean().default(true),
  silent: z.boolean().default(false),
  showPreviewText: z.boolean().default(true),
});

/** Full schema — includes provider-specific webhook URL validation */
export const configSchema = baseConfigSchema.superRefine((data, ctx) => {
  const provider = data.provider ?? ProviderName.GOOGLE_CHAT;
  const expectedPrefix = PROVIDER_WEBHOOK_PREFIXES[provider];

  if (expectedPrefix && !data.webhookUrl.startsWith(expectedPrefix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['webhookUrl'],
      message: `webhookUrl must start with "${expectedPrefix}" for ${provider} provider. Received: "${data.webhookUrl}"`,
    });
  }
});

export type AlertHookConfig = z.input<typeof baseConfigSchema>;
export type ResolvedConfig = z.output<typeof baseConfigSchema>;

// ─── Alert Payload Schema ────────────────────────────────────────

export const alertPayloadSchema = z.object({
  severity: severitySchema,
  message: z.string(),
  stack: z.string().optional(),
  context: z.record(z.string(), z.unknown()),
  globalContext: z.record(z.string(), z.unknown()),
  appName: z.string(),
  environment: z.string(),
  version: z.string().optional(),
  timestamp: z.string(),
  fingerprint: z.string(),
  occurrences: z.number().int().positive(),
  showPreviewText: z.boolean(),
});

export type AlertPayload = z.infer<typeof alertPayloadSchema>;

// ─── Provider Interface ──────────────────────────────────────────
// Kept as interface — Zod can't express async method contracts.
// This is the only non-Zod type, intentionally.

export interface AlertProvider {
  readonly name: string;
  send(payload: AlertPayload): Promise<void>;
}
