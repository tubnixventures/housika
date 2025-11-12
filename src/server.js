import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { prettyJSON } from 'hono/pretty-json';

import appRouter from './routes/routes.js';
import { getCollection } from './services/astra.js';
import { checkToken } from './utils/auth.js';

const app = new Hono();
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = process.env.PORT || 3000;

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

// --- ⚡ Fast Middleware Chain ---
app.use(secureHeaders());
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  allowHeaders: ['Authorization', 'X-Custom-Header', 'Upgrade-Insecure-Requests'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}));
if (NODE_ENV !== 'production') app.use(logger());
app.use(prettyJSON());

// --- 🧭 Route Mounting ---
app.route('/', appRouter);

// --- 🛡️ Error Handling ---
app.onError((err, c) => {
  const statusCode = err.status || 500;
  return c.json({
    error: statusCode === 500 ? 'Internal Server Error' : err.message,
    details: NODE_ENV !== 'production' ? err.message : undefined,
  }, statusCode);
});

// --- 🚫 404 Handler ---
app.notFound((c) => c.json({
  message: 'Not Found',
  description: `The resource at ${c.req.path} does not exist.`,
}, 404));

// --- 🩺 Health Check ---
app.get('/health', async (c) => {
  const start = Date.now();
  const traceId = c.req.header('x-trace-id') || 'health-check';
  try {
    await getCollection('users');
    return c.json({ status: 'ok', latency: `${Date.now() - start}ms`, traceId });
  } catch {
    return c.json({ status: 'error', latency: `${Date.now() - start}ms`, traceId }, 503);
  }
});

// --- 🚀 Start Server ---
serve({ fetch: app.fetch, port: PORT });
console.log(`🚀 Server running on http://localhost:${PORT}`);
