# pk-alert-hook — Agent Integration Guide

## What is this?

A lightweight error alerting library that sends runtime errors to Google Chat via webhooks. Drop it into any Node.js/TypeScript project to get instant chat alerts from catch blocks.

## Setup in a new project

### 1. Install

```bash
npm install pk-alert-hook
```

### 2. Add env variable

Add to your `.env` file:

```env
PK_ALERT_GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/SPACE_ID/messages?key=KEY&token=TOKEN
```

### 3. Initialize once at app entry point

Add this to your main entry file (`main.ts`, `server.ts`, `app.ts`, or equivalent):

```ts
import { AlertHook } from 'pk-alert-hook';

AlertHook.init({
  webhookUrl: process.env.PK_ALERT_GOOGLE_CHAT_WEBHOOK_URL!,
  environment: process.env.NODE_ENV!,
  allowedEnvs: ['production', 'staging'],
  appName: 'PROJECT_NAME_HERE',
  timezone: 'UTC',
});
```

### 4. Use in catch blocks

Anywhere you have a try/catch, add `AlertHook.capture()`:

```ts
try {
  await someOperation();
} catch (err) {
  AlertHook.capture(err, { relevantId: 'value', route: '/api/endpoint' });
  throw err; // re-throw if needed
}
```

### 5. Graceful shutdown (optional but recommended)

```ts
process.on('SIGTERM', async () => {
  await AlertHook.flush();
  process.exit(0);
});
```

## Rules for agents

- **Never hardcode webhook URLs.** Always read from `process.env.PK_ALERT_GOOGLE_CHAT_WEBHOOK_URL`.
- **Never wrap AlertHook calls in try/catch.** The library already never throws. Adding extra try/catch is redundant.
- **Always pass useful context.** Include identifiers that help debug: `userId`, `orderId`, `route`, `requestId`, etc. Don't pass sensitive data like passwords or tokens.
- **Don't await `capture()` or `alert()`.** They are fire-and-forget. Only `flush()` is awaitable.
- **Call `init()` once.** At app startup only. Not per-request, not in middleware, not in a loop.
- **`allowedEnvs` must match your `NODE_ENV` values exactly.** If your staging uses `NODE_ENV=staging`, put `'staging'` in the array.
- **Don't import internals.** Only use the public API: `AlertHook`, `Severity`, and types.

## API quick reference

```ts
// Required — call once at startup
AlertHook.init(config);

// In catch blocks — fire-and-forget, never throws
AlertHook.capture(error, { context });

// Manual alerts — defaults to WARNING severity
AlertHook.alert('message', { context });
AlertHook.alert('message', { context }, Severity.INFO);

// Persistent context — added to every alert automatically
AlertHook.setGlobalContext({ region: 'us-east-1' });
AlertHook.clearGlobalContext();

// Graceful shutdown — await pending sends
await AlertHook.flush();

// Cleanup
AlertHook.destroy();
```

## Config options

| Option | Required | Default | Notes |
|--------|----------|---------|-------|
| `webhookUrl` | yes | — | Must start with `https://chat.googleapis.com/` |
| `environment` | yes | — | Your `NODE_ENV` value |
| `allowedEnvs` | yes | — | Array of envs that should send alerts |
| `appName` | yes | — | Identifies the app in alert cards |
| `version` | no | — | Shown in alert footer |
| `maxStackLength` | no | `500` | Truncates stack traces |
| `timezone` | no | `'UTC'` | IANA timezone string |
| `rateLimitWindowMs` | no | `300000` | 5min dedup window |
| `rateLimitEnabled` | no | `true` | Set `false` to send every error |
| `silent` | no | `false` | Suppress console warnings |
| `showPreviewText` | no | `true` | Show notification preview text above card |

## Common patterns

### Express error handler

```ts
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  AlertHook.capture(err, { method: req.method, path: req.path, userId: req.user?.id });
  res.status(500).json({ error: 'Internal server error' });
});
```

### NestJS exception filter

```ts
@Catch()
export class AlertHookFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();
    AlertHook.capture(exception, { method: request.method, path: request.url });
    // ... handle response
  }
}
```

### Next.js API route

```ts
export async function POST(request: Request) {
  try {
    // ... handle request
  } catch (err) {
    AlertHook.capture(err, { route: 'POST /api/endpoint' });
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

## Project supports

- Google Chat webhooks only (no Slack, Discord, email)
- Node.js 18+ (uses native fetch)
- TypeScript and JavaScript (ESM only)
- Zod 4 for all validation
