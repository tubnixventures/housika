import 'dotenv/config';
import cluster from 'cluster';
import os from 'os';
import crypto from 'crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { prettyJSON } from 'hono/pretty-json';
import compression from 'compression';
import http from 'http';
import https from 'https';

import appRouter from './routes/routes.js';
import { getCollection } from './services/astra.js';
import { checkToken, redis as upstashRedis } from './utils/auth.js';

const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT || 3000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15_000);
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 30); // default 30s for banners/rooms/etc
const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const MIN_WORKERS = Number(process.env.MIN_WORKERS || 1);
const RATE_LIMIT_PREFIX = process.env.RATE_LIMIT_PREFIX || 'rl';
const RATE_LIMIT_WINDOW_SEC = Number(process.env.RATE_LIMIT_WINDOW_SEC || 60);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 120);

// --- Simple in-memory fallback cache (very small, TTL-aware) ---
const inMemoryCache = new Map(); // key -> { value, exp }
function setInMemory(key, value, ttlSec) {
  inMemoryCache.set(key, { value, exp: Date.now() + ttlSec * 1000 });
}
function getInMemory(key) {
  const entry = inMemoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    inMemoryCache.delete(key);
    return null;
  }
  return entry.value;
}

// --- Helper: prefixed redis get/set with fail-open fallback ---
async function cacheGet(key) {
  const pref = `${CACHE_KEY_PREFIX}:${key}`;
  try {
    const v = await upstashRedis.get(pref);
    if (v != null) return JSON.parse(v);
  } catch (e) {
    // fail-open: fallback to in-memory
    console.warn('Redis get failed, using in-memory fallback for', pref, e?.message || e);
  }
  return getInMemory(pref);
}
async function cacheSet(key, value, ttlSec = CACHE_TTL_SEC) {
  const pref = `${CACHE_KEY_PREFIX}:${key}`;
  const payload = JSON.stringify(value);
  try {
    await upstashRedis.set(pref, payload);
    if (typeof upstashRedis.expire === 'function') {
      await upstashRedis.expire(pref, ttlSec);
    }
  } catch (e) {
    // fallback
    setInMemory(pref, value, ttlSec);
    console.warn('Redis set failed, cached in-memory for', pref, e?.message || e);
  }
}

// --- Warmup/preload critical collections and cache keys ---
async function prewarmCaches() {
  const keysToPrewarm = [
    { key: 'banners', coll: 'banners' },
    { key: 'rooms', coll: 'rooms' },
    { key: 'countries', coll: 'countries' },
    { key: 'properties', coll: 'properties' },
  ];

  await Promise.allSettled(
    keysToPrewarm.map(async ({ key, coll }) => {
      try {
        const col = await getCollection(coll);
        let payload = null;
        if (!col) {
          payload = { warmed: true };
        } else if (typeof col.find === 'function') {
          // Try to call find with a safe shape and normalise result
          try {
            const res = await col.find({}, { limit: 100 });
            payload = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : Object.values(res?.data || {});
          } catch (e) {
            // If driver doesn't accept options, try simple find
            const res2 = await col.find({});
            payload = Array.isArray(res2) ? res2 : Array.isArray(res2?.data) ? res2.data : Object.values(res2?.data || {});
          }
        } else if (typeof col.getAll === 'function') {
          payload = await col.getAll();
        } else {
          payload = { warmed: true };
        }
        await cacheSet(key, payload, CACHE_TTL_SEC);
        console.log(`🔁 Prewarmed cache key: ${key}`);
      } catch (err) {
        console.warn(`⚠️ Failed to prewarm ${key}:`, err?.message || err);
      }
    })
  );

  // Warm auth check token to avoid first-request crypto cost (best-effort)
  try {
    await checkToken('warmup-token');
  } catch (e) {
    // ignore
  }
}

// --- Cluster: allow multiple workers to reduce tail-latency and utilize cores ---
if (cluster.isPrimary) {
  const cpuCount = Math.max(MIN_WORKERS, Math.max(1, os.cpus().length - 1));
  for (let i = 0; i < cpuCount; i++) cluster.fork();
  cluster.on('exit', (worker, code, signal) => {
    console.error(`worker ${worker.process.pid} died (code=${code} signal=${signal}), respawning`);
    cluster.fork();
  });
  console.log(`Master started. Forked ${cpuCount} workers`);
  // Prewarm from master to reduce thundering herd on first worker start
  prewarmCaches().catch((e) => console.warn('Warmup error (master):', e?.message || e));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  // Note: do not continue bootstrapping server in master
} else {
  // --- Worker process starts below ---
  const app = new Hono();

  // --- Keep-alive agent for efficient outbound connections (if you call external APIs) ---
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
  // Optionally export agents for HTTP clients to reuse
  global.__HTTP_KEEP_ALIVE_AGENT = { httpAgent, httpsAgent };

  // --- Rate limiter config (Upstash sliding window, fail-open) ---
  app.use('*', async (c, next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim()
      || c.req.socket?.remoteAddress
      || 'unknown';
    const key = `${RATE_LIMIT_PREFIX}:${ip}`;
    try {
      const count = await upstashRedis.incr(key);
      if (Number(count) === 1 && typeof upstashRedis.expire === 'function') {
        await upstashRedis.expire(key, RATE_LIMIT_WINDOW_SEC);
      }
      if (Number(count) > RATE_LIMIT_MAX) {
        const ttl = await upstashRedis.ttl(key).catch(() => RATE_LIMIT_WINDOW_SEC);
        return c.json({ error: 'Too many requests', retryAfter: ttl >= 0 ? ttl : RATE_LIMIT_WINDOW_SEC }, 429);
      }
    } catch (err) {
      // allow through if redis unavailable
      console.warn('Rate limiter Redis error (fail-open):', err?.message || err);
    }
    return next();
  });

  // --- CORS, timeout guard, and AbortController like original ---
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin) c.header('Vary', 'Origin');

    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
    } else {
      c.header('Access-Control-Allow-Origin', '*');
    }

    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, X-Custom-Header');
    c.header('Access-Control-Expose-Headers', 'Content-Length, X-Request-Id, X-Cache');
    c.header('Access-Control-Max-Age', '600');

    if (c.req.method === 'OPTIONS') return c.text('', 204);

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
      if (err?.message === 'Timeout') return c.json({ error: 'Request timeout' }, 504);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  });

  // --- Security, logging, compression and pretty JSON ---
  app.use(secureHeaders());
  if (NODE_ENV !== 'production') app.use(logger());
  if (NODE_ENV !== 'production') app.use(prettyJSON({ spaces: 2 }));
  app.use('*', async (c, next) => {
    // If you integrate compression with your platform, prefer that; otherwise this is a no-op placeholder
    // (Hono native environment may not support middleware-style compression).
    return next();
  });

  // --- Cache middleware for frequently used GET endpoints ---
  const CACHEABLE_PATHS = new Set(['/banners', '/rooms', '/countries', '/properties']);
  app.use('*', async (c, next) => {
    try {
      if (c.req.method === 'GET' && CACHEABLE_PATHS.has(c.req.path)) {
        const cacheKey = c.req.path; // extend with query/user if needed
        const cached = await cacheGet(cacheKey);
        if (cached != null) {
          c.header('X-Cache', 'HIT');
          c.header('Cache-Control', `public, max-age=${CACHE_TTL_SEC}`);
          return c.json(cached);
        }
        // continue to route handler; handlers should set c.set('cachePayload', payload) with fresh payload
        const res = await next();
        const body = c.get('cachePayload'); // route handlers should set this
        if (body != null) {
          await cacheSet(cacheKey, body, CACHE_TTL_SEC);
        }
        return res;
      }
    } catch (err) {
      console.warn('Cache middleware error (fail-open):', err?.message || err);
    }
    return next();
  });

  // --- Mount user routes ---
  // Ensure route handlers serving GET /banners, /rooms, /countries, /properties call:
  // c.set('cachePayload', payload) after fetching fresh data so middleware can cache it.
  app.route('/', appRouter);

  // --- Structured error handler and 404 ---
  app.onError((err, c) => {
    const statusCode = err.status || (err.name === 'Unauthorized' ? 401 : 500);
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
  app.notFound((c) => c.json({
    message: 'Not Found',
    description: `The resource at ${c.req.path} does not exist.`,
  }, 404));

  // --- Health check ---
  app.get('/health', async (c) => {
    const start = Date.now();
    const traceId = c.req.header('x-trace-id') || 'health-check';
    try {
      await getCollection('users');
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

  // --- Server start / graceful shutdown ---
  let server = null;
  function start() {
    server = serve({ fetch: app.fetch, port: PORT });
    console.log(`🚀 Worker ${process.pid} running on http://localhost:${PORT}`);
    // warm caches from worker too (best-effort, master already attempted)
    prewarmCaches().catch((e) => console.warn('Warmup error (worker):', e?.message || e));
  }
  async function stop(signal) {
    console.log(`🛑 Worker ${process.pid} received ${signal}. Shutting down...`);
    try {
      if (server?.close) await new Promise(res => server.close(res));
    } catch (err) {
      console.error('Error during server close', err);
    } finally {
      try {
        if (upstashRedis.disconnect) await upstashRedis.disconnect();
      } catch (e) {}
      process.exit(0);
    }
  }
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  start();
}
