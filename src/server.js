import 'dotenv/config'
import cluster from 'cluster'
import os from 'os'
import http from 'http'
import https from 'https'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { prettyJSON } from 'hono/pretty-json'

import appRouter from './routes/routes.js'
import { getCollection } from './services/astra.js'
import { checkToken, redis as upstashRedis } from './utils/auth.js'

// --- Config ---
const NODE_ENV = process.env.NODE_ENV || 'development'
const PORT = Number(process.env.PORT || 3000)
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15_000)
const MIN_WORKERS = Number(process.env.MIN_WORKERS || 1)
const RATE_LIMIT_PREFIX = process.env.RATE_LIMIT_PREFIX || 'rl'
const RATE_LIMIT_WINDOW_SEC = Number(process.env.RATE_LIMIT_WINDOW_SEC || 60)
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 120)

// --- Warmup (best-effort) ---
async function prewarmCaches() {
  try {
    await Promise.allSettled([
      getCollection('users'),
      getCollection('properties'),
      getCollection('rooms'),
      getCollection('countries'),
      checkToken('warmup-token'),
    ])
  } catch {
    // ignore
  }
}

// --- Cluster master ---
if (cluster.isPrimary) {
  const cpuCount = Math.max(MIN_WORKERS, Math.max(1, os.cpus().length - 1))
  for (let i = 0; i < cpuCount; i++) cluster.fork()
  cluster.on('exit', (worker, code, signal) => {
    console.error(`worker ${worker.process.pid} died (code=${code} signal=${signal}), respawning`)
    cluster.fork()
  })
  console.log(`Master started. Forked ${cpuCount} workers`)
  prewarmCaches().catch((e) => console.warn('Warmup error (master):', e?.message || e))
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
} else {
  // --- Worker ---
  const app = new Hono()

  // Keep-alive agents for outbound calls
  global.__HTTP_KEEP_ALIVE_AGENT = {
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 100 }),
  }

  // --- Rate limiter ---
  app.use('*', async (c, next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim()
      || c.req.socket?.remoteAddress
      || 'unknown'
    const key = `${RATE_LIMIT_PREFIX}:${ip}`
    try {
      const count = await upstashRedis.incr(key)
      if (Number(count) === 1 && typeof upstashRedis.expire === 'function') {
        await upstashRedis.expire(key, RATE_LIMIT_WINDOW_SEC)
      }
      if (Number(count) > RATE_LIMIT_MAX) {
        const ttl = await upstashRedis.ttl(key).catch(() => RATE_LIMIT_WINDOW_SEC)
        return c.json({ error: 'Too many requests', retryAfter: ttl >= 0 ? ttl : RATE_LIMIT_WINDOW_SEC }, 429)
      }
    } catch (err) {
      if (NODE_ENV !== 'production') console.warn('Rate limiter Redis error:', err?.message || err)
    }
    return next()
  })

  // --- CORS + timeout ---
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    if (origin) {
      c.header('Vary', 'Origin')
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Access-Control-Allow-Credentials', 'true')
    } else {
      c.header('Access-Control-Allow-Origin', '*')
    }
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, X-Custom-Header, x-trace-id')
    c.header('Access-Control-Expose-Headers', 'Content-Length, X-Request-Id, X-Trace-Id')
    c.header('Access-Control-Max-Age', '600')

    if (c.req.method === 'OPTIONS') return c.text('', 204)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await Promise.race([
        next(),
        (async () => {
          await new Promise((_, rej) => controller.signal.addEventListener('abort', () => rej(new Error('Timeout'))))
        })(),
      ])
    } catch (err) {
      if (err?.message === 'Timeout') return c.json({ error: 'Request timeout' }, 504)
      throw err
    } finally {
      clearTimeout(timeout)
    }
  })

  // --- Security + logging ---
  app.use(secureHeaders())
  if (NODE_ENV !== 'production') app.use(logger())
  if (NODE_ENV !== 'production') app.use(prettyJSON({ spaces: 2 }))

  // --- Routes ---
  app.route('/', appRouter)

  // --- Health check ---
  app.get('/health', async (c) => {
    const start = Date.now()
    const traceId = c.req.header('x-trace-id') || 'health-check'
    try {
      await getCollection('users')
      await upstashRedis.ping()
      const latency = Date.now() - start
      return c.json({ status: 'ok', latency: `${latency}ms`, traceId })
    } catch (err) {
      const latency = Date.now() - start
      return c.json({ status: 'error', latency: `${latency}ms`, traceId, reason: NODE_ENV !== 'production' ? err.message : undefined }, 503)
    }
  })

  // --- Error handler ---
  app.onError((err, c) => {
    const statusCode = err.status || (err.name === 'Unauthorized' ? 401 : 500)
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      path: c.req.path,
      method: c.req.method,
      status: statusCode,
      message: err.message,
      stack: NODE_ENV !== 'production' ? err.stack : undefined,
    }))
    return c.json({
      error: statusCode === 500 ? 'Internal Server Error' : err.message,
      details: NODE_ENV !== 'production' ? err.stack || err.message : undefined,
    }, statusCode)
  })

  app.notFound((c) => c.json({
    message: 'Not Found',
    description: `The resource at ${c.req.path} does not exist.`,
  }, 404))

  // --- Start/stop ---
  let server = null
  function start() {
    server = serve({ fetch: app.fetch, port: PORT })
    console.log(`🚀 Worker ${process.pid} running on http://localhost:${PORT}`)
    prewarmCaches().catch((e) => console.warn('Warmup error (worker):', e?.message || e))
  }
  async function stop(signal) {
    console.log(`🛑 Worker ${process.pid} received ${signal}. Shutting down...`)
    try {
      if (server?.close) await new Promise(res => server.close(res))
    } catch (err) {
      console.error('Error during server close', err)
    } finally {
      try {
        if (upstashRedis.disconnect) await upstashRedis.disconnect()
      } catch {}
      process.exit(0)
    }
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  start()
}
