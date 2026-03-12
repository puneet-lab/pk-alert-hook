/**
 * Quick local test — sends a real alert to your Google Chat space.
 *
 * Setup:
 *   1. cp examples/.env.example examples/.env
 *   2. Fill in your webhook URL in examples/.env
 *   3. npx tsx examples/basic.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlertHook, Severity } from '../src/index.js';

// Load .env from examples directory
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '.env');

try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env file is optional if env vars are already set
}

const webhookUrl = process.env.PK_ALERT_GOOGLE_CHAT_WEBHOOK_URL;

if (!webhookUrl) {
  throw new Error(
    'PK_ALERT_GOOGLE_CHAT_WEBHOOK_URL is not set.\n' +
    'Setup:\n' +
    '  1. cp examples/.env.example examples/.env\n' +
    '  2. Fill in your webhook URL in examples/.env\n',
  );
}

if (!webhookUrl.startsWith('https://chat.googleapis.com/')) {
  throw new Error(
    `PK_ALERT_GOOGLE_CHAT_WEBHOOK_URL is invalid: "${webhookUrl}"\n` +
    'Expected a Google Chat webhook URL starting with https://chat.googleapis.com/',
  );
}

AlertHook.init({
  webhookUrl,
  environment: 'production',
  allowedEnvs: ['production'],
  appName: 'pk-alert-hook-test',
  timezone: 'Asia/Bangkok',
  version: '0.1.0',
});

async function main() {
  console.log('--- pk-alert-hook quick test ---\n');

  // Set some global context (attached to every alert automatically)
  AlertHook.setGlobalContext({ region: 'us-east-1', service: 'test-runner' });

  // ── Test 1: Error capture ──
  console.log('1. Sending error alert...');
  try {
    throw new Error('Payment gateway timeout');
  } catch (err) {
    AlertHook.capture(err, { orderId: 'ORD-9821', userId: 'usr_abc123', route: 'POST /api/orders' });
  }

  // ── Test 2: Warning alert ──
  console.log('2. Sending warning alert...');
  AlertHook.alert('Disk usage at 92%', { disk: '/dev/sda1', threshold: '90%' });

  // ── Test 3: Info alert ──
  console.log('3. Sending info alert...');
  AlertHook.alert('Deploy complete', { version: '0.1.0', commit: 'a1b2c3d' }, Severity.INFO);

  // ── Test 4: Rate limiting with "occurred N times" ──
  // Use a short 3-second window so we can see the count in the test
  console.log('4. Testing rate limiter with occurrence count...');
  AlertHook.destroy();
  AlertHook.init({
    webhookUrl,
    environment: 'production',
    allowedEnvs: ['production'],
    appName: 'pk-alert-hook-test',
    timezone: 'Asia/Bangkok',
    version: '0.1.0',
    rateLimitWindowMs: 3_000, // 3 seconds for testing
  });
  AlertHook.setGlobalContext({ region: 'us-east-1', service: 'test-runner' });

  // Fire same error 5 times → first sends immediately, rest suppressed
  for (let i = 0; i < 5; i++) {
    try {
      throw new Error('Database connection pool exhausted');
    } catch (err) {
      AlertHook.capture(err, { attempt: i + 1 });
    }
  }
  console.log('   Sent 5 identical errors, first one sent immediately...');

  // Wait for the 3-second window to expire
  console.log('   Waiting 4 seconds for rate limit window to expire...');
  await new Promise((resolve) => setTimeout(resolve, 4_000));

  // Fire same error again → this time it sends WITH "Occurred 6 times" badge
  try {
    throw new Error('Database connection pool exhausted');
  } catch (err) {
    AlertHook.capture(err, { attempt: 6 });
  }
  console.log('   Sent 6th error → should show "Occurred 6 times" in card');

  // ── Test 5: Environment filtering ──
  // This should NOT send because 'development' is not in allowedEnvs
  console.log('5. Testing env filtering (this should NOT send)...');
  AlertHook.destroy();
  AlertHook.init({
    webhookUrl,
    environment: 'development',
    allowedEnvs: ['production'],
    appName: 'pk-alert-hook-test',
    timezone: 'Asia/Bangkok',
  });
  AlertHook.capture(new Error('This should be silently ignored'));

  // Wait for all pending alerts
  await AlertHook.flush();
  AlertHook.destroy();

  console.log('\n--- Results ---');
  console.log('Check your Google Chat space. You should see:');
  console.log('  - 1x Error card (Payment gateway timeout)');
  console.log('  - 1x Warning card (Disk usage at 92%)');
  console.log('  - 1x Info card (Deploy complete)');
  console.log('  - 1x Error card (Database connection pool exhausted) — first occurrence');
  console.log('  - 1x Error card (Database connection pool exhausted) — with "Occurred 6 times"');
  console.log('  - Nothing from test 5 (env filtered)');
  console.log('\nTotal: 5 messages');
}

main().catch(console.error);
