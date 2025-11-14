import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { prettyJSON } from 'hono/pretty-json';

import appRouter from './routes/routes.js';
import { getCollection } from './services/astra.js';
import { checkToken, redis as upstashRedis } from './utils/auth.js';

const app = new Hono();
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT || 3000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15_000);

// --- 🔥 Prewarm critical services (non-blocking) ---
Promise.allSettled([
  getCollection('users'),
  checkToken('warmup-token'),
]).then(results => {
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`⚠️ Warmup ${i} failed:`, r.reason?.message || r.reason);
    }
  });
});

// --- Redis-backed sliding window rate limiter configuration ---
const RATE_LIMIT_WINDOW_SEC = Number(process.env.RATE_LIMIT_WINDOW_SEC || 60); // window in seconds
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 120); // max requests per window
const RATE_LIMIT_PREFIX = process.env.RATE_LIMIT_PREFIX || 'rl'; // redis key prefix

/**
 * Redis sliding window algorithm (uses INCR + EXPIRE and optional ZSET approach).
 * This implementation uses a simple counter with expiry which is sufficient for typical rate-limits
 * and works well with Upstash Redis. For stricter guarantees across distributed instances,
 * use the token-bucket or sorted-set timestamp approach.
 */
app.use('*', async (c, next) => {
  // Identify client: prefer X-Forwarded-For set by proxy; fallback to remote address
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim()
    || c.req.socket?.remoteAddress
    || 'unknown';

  const key = `${RATE_LIMIT_PREFIX}:${ip}`;
  try {
    // Use Redis INCR and TTL to create a sliding-window-ish counter
    const count = await upstashRedis.incr(key);
    if (count === 1) {
      // first seen in window, set expiry to window length
      await upstashRedis.expire(key, RATE_LIMIT_WINDOW_SEC);
    }
    if (count > RATE_LIMIT_MAX) {
      // Retrieve TTL to inform client how long to wait (seconds)
      const ttl = await upstashRedis.ttl(key);
      return c.json({ error: 'Too many requests', retryAfter: ttl >= 0 ? ttl : RATE_LIMIT_WINDOW_SEC }, 429);
    }
  } catch (err) {
    // If Redis is down/unreachable, allow requests but log (fail-open)
    console.error('Rate limiter Redis error:', err);
  }

  return next();
});

// --- CORS: echo origin to allow arbitrary domains while keeping credentials ---
app.use('*', async (c, next) => {
  const origin = c.req.header('origin');

  // Always set Vary so caches know responses vary by Origin
  if (origin) c.header('Vary', 'Origin');

  // Echo the origin if present. This lets you use arbitrary domains (free domains) while
  // still returning a concrete Access-Control-Allow-Origin (required when credentials:true).
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
  } else {
    // No origin header (same-origin or non-browser client)
    c.header('Access-Control-Allow-Origin', '*');
  }

  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, X-Custom-Header');
  c.header('Access-Control-Expose-Headers', 'Content-Length, X-Request-Id');
  c.header('Access-Control-Max-Age', '600');

  // Fast preflight response
  if (c.req.method === 'OPTIONS') {
    if (!origin) return c.text('', 204);
    return c.text('', 204);
  }

  // Request-level timeout guard (AbortController) to avoid resource exhaustion
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await Promise.race([
      next(),
      (async () => {
        await new Promise((_, rej) => controller.signal.addEventListener('abort', () => rej(new Error('Timeout'))));
      })(),
    ]);
  } catch (err) {
    if (err?.message === 'Timeout') {
      return c.json({ error: 'Request timeout' }, 504);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
});

// --- Security, logging, and JSON formatting ---
app.use(secureHeaders());
if (NODE_ENV !== 'production') app.use(logger());
if (NODE_ENV !== 'production') app.use(prettyJSON({ spaces: 2 }));

// --- Route Mounting ---
app.route('/', appRouter);

// --- Structured error handler ---
app.onError((err, c) => {
  const statusCode = err.status || (err.name === 'Unauthorized' ? 401 : 500);
  // Server-side structured logging for observability
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    path: c.req.path,
    method: c.req.method,
    status: statusCode,
    message: err.message,
    stack: NODE_ENV !== 'production' ? err.stack : undefined,
  }));
  return c.json({
    error: statusCode === 500 ? 'Internal Server Error' : err.message,
    details: NODE_ENV !== 'production' ? err.stack || err.message : undefined,
  }, statusCode);
});

// --- 404 Handler ---
app.notFound((c) => c.json({
  message: 'Not Found',
  description: `The resource at ${c.req.path} does not exist.`,
}, 404));

// --- Health Check: readiness for critical dependency (Redis + DB) ---
app.get('/health', async (c) => {
  const start = Date.now();
  const traceId = c.req.header('x-trace-id') || 'health-check';
  try {
    // Check DB
    await getCollection('users');
    // Check Redis (simple ping or set/get)
    try {
      await upstashRedis.ping();
    } catch (rErr) {
      throw new Error(`Redis unreachable: ${rErr.message}`);
    }
    const latency = Date.now() - start;
    return c.json({ status: 'ok', latency: `${latency}ms`, traceId });
  } catch (err) {
    const latency = Date.now() - start;
    return c.json({ status: 'error', latency: `${latency}ms`, traceId, reason: NODE_ENV !== 'production' ? err.message : undefined }, 503);
  }
});

// --- Graceful shutdown handling ---
let server = null;
function start() {
  server = serve({ fetch: app.fetch, port: PORT });
  console.log(`🚀 Server running on http://localhost:${PORT}`);
}
async function stop(signal) {
  console.log(`🛑 Received ${signal}. Shutting down...`);
  try {
    if (server?.close) await new Promise(res => server.close(res));
  } catch (err) {
    console.error('Error during server close', err);
  } finally {
    // Optional: close Redis client if the library exposes a close method
    try {
      if (upstashRedis.disconnect) await upstashRedis.disconnect();
    } catch (e) {
      // ignore
    }
    process.exit(0);
  }
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

start();
