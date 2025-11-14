import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken, redis as upstashRedis } from '../../utils/auth.js';

// Cache config
const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 30); // short TTL for messages listing
const INMEM_TTL_MS = Number(process.env.INMEM_CONTACT_TTL_MS || 5000);
const INMEM_MAX = Number(process.env.INMEM_CONTACT_MAX || 200);

// in-process fallback cache
const inMemCache = new Map(); // key -> { ts, value }
const cleanupInMem = () => {
  if (inMemCache.size <= INMEM_MAX) return;
  const keys = Array.from(inMemCache.keys()).sort((a, b) => inMemCache.get(a).ts - inMemCache.get(b).ts);
  for (let i = 0; i < Math.floor(keys.length / 4); i += 1) {
    inMemCache.delete(keys[i]);
    if (inMemCache.size <= INMEM_MAX) break;
  }
};
const inMemGet = (k) => {
  const e = inMemCache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > INMEM_TTL_MS) {
    inMemCache.delete(k);
    return null;
  }
  return e.value;
};
const inMemSet = (k, v) => {
  inMemCache.set(k, { ts: Date.now(), value: v });
  cleanupInMem();
};

// Redis helpers (best-effort)
const redisGet = async (key) => {
  try {
    const raw = await upstashRedis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Redis get error (contact messages):', e?.message || e);
    return null;
  }
};
const redisSet = async (key, payload, ttlSec = CACHE_TTL_SEC) => {
  try {
    await upstashRedis.set(key, JSON.stringify(payload));
    if (typeof upstashRedis.expire === 'function') {
      await upstashRedis.expire(key, ttlSec);
    }
  } catch (e) {
    console.warn('Redis set error (contact messages):', e?.message || e);
  }
};

// projection to return only required fields
const projectMessage = (m) => ({
  id: m.id || m._id || null,
  fullname: m.fullname || m.name || null,
  email: m.email || null,
  phonenumber: m.phonenumber || m.phone || null,
  subject: m.subject || null,
  body: m.body || m.message || null,
  replied: !!m.replied,
  created_at: m.created_at || m.createdAt || null,
  metadata: m.metadata || null,
});

// deterministic cache key for the query and pagination
const makeCacheKey = ({ email, from, to, repliedQ, page, per_page }) => {
  const parts = [
    `${CACHE_KEY_PREFIX}:contact_messages`,
    `email=${email || ''}`,
    `from=${from || ''}`,
    `to=${to || ''}`,
    `replied=${repliedQ || 'any'}`,
    `p=${page}`,
    `pp=${per_page}`,
  ];
  return parts.join('|');
};

export const getContactMessages = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID?.() || `trace-${Date.now()}`;
  const token = c.req.header('Authorization')?.replace('Bearer ', '') || '';

  // Quick auth + role check
  if (!token) {
    return c.json({ success: false, error: 'MISSING_TOKEN', message: 'Missing authentication token.', timestamp, traceId }, 401);
  }
  const actor = await checkToken(token).catch((err) => {
    console.error('❌ Token check failed:', err?.message || err);
    return null;
  });
  if (!actor || !['customer care', 'admin', 'ceo'].includes(actor.role)) {
    return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Only customer care, admin, or ceo can view contact messages.', timestamp, traceId }, 403);
  }

  // Resolve collection
  let contactMessages;
  try {
    contactMessages = await getCollection('contact_messages');
    if (!contactMessages || typeof contactMessages.find !== 'function') {
      throw new Error('Collection "contact_messages" missing .find() method.');
    }
  } catch (err) {
    console.error('❌ DB connection failed:', err?.message || err);
    return c.json({ success: false, error: 'DB_CONNECTION_FAILED', message: 'Database connection failed.', timestamp, traceId }, 503);
  }

  // Parse query params
  const rawPage = c.req.query('page') || '1';
  const rawPerPage = c.req.query('per_page') || c.req.query('perPage') || '20';
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const per_page = Math.min(100, Math.max(1, parseInt(rawPerPage, 10) || 20));

  const email = c.req.query('email') || '';
  const from = c.req.query('from') || '';
  const to = c.req.query('to') || '';
  const repliedQ = (c.req.query('replied') || '').toLowerCase(); // 'true' | 'false' | 'any' | ''

  const cacheKey = makeCacheKey({ email, from, to, repliedQ, page, per_page });

  // Try caches
  const cachedRedis = await redisGet(cacheKey);
  if (cachedRedis != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.set('cachePayload', cachedRedis.data);
    return c.json({ success: true, ...cachedRedis.meta, data: cachedRedis.data, cached: true, timestamp, traceId, actor_id: actor.userId }, 200);
  }
  const cachedMem = inMemGet(cacheKey);
  if (cachedMem != null) {
    c.header('X-Cache', 'HIT-MEM');
    c.set('cachePayload', cachedMem.data);
    return c.json({ success: true, ...cachedMem.meta, data: cachedMem.data, cached: true, timestamp, traceId, actor_id: actor.userId }, 200);
  }

  // Build DB query object
  const query = {};
  if (email) query.email = { $eq: email };
  if (from || to) {
    query.created_at = {};
    if (from) query.created_at.$gte = from;
    if (to) query.created_at.$lte = to;
  }
  if (repliedQ === 'true') query.replied = { $eq: true };
  else if (repliedQ === 'false') query.replied = { $eq: false };
  // if repliedQ is 'any' or empty -> no replied filter, we'll prioritise later

  // Fetch matching messages
  let messages = [];
  try {
    // Try server-side pagination if supported
    let result;
    try {
      result = await contactMessages.find(query, { limit: per_page, offset: (page - 1) * per_page, sort: { replied: 1, created_at: -1 } });
    } catch (_) {
      // fallback to unpaged fetch
      result = await contactMessages.find(query);
    }
    messages = Array.isArray(result?.data) ? result.data : Object.values(result?.data || {});
  } catch (err) {
    console.error('❌ Query failed:', err?.message || err);
    return c.json({ success: false, error: 'QUERY_FAILED', message: 'Failed to retrieve contact messages.', timestamp, traceId }, 500);
  }

  // Normalize and prioritise unreplied then newest
  const normalized = messages.map((m) => ({
    ...m,
    __created_at_date: m.created_at ? new Date(m.created_at) : new Date(0),
    __replied_bool: !!m.replied,
  }));

  normalized.sort((a, b) => {
    if (a.__replied_bool !== b.__replied_bool) return a.__replied_bool ? 1 : -1;
    return b.__created_at_date - a.__created_at_date;
  });

  // If server-side paging wasn't applied, slice here
  const total = normalized.length;
  const totalPages = Math.max(1, Math.ceil(total / per_page));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * per_page;
  const pageSlice = normalized.slice(start, start + per_page).map((m) => {
    const { __created_at_date, __replied_bool, ...rest } = m;
    return projectMessage(rest);
  });

  // Build pagination buttons (up to 5, centered)
  const maxButtons = 5;
  let startPage = 1;
  let endPage = Math.min(totalPages, maxButtons);
  if (totalPages > maxButtons) {
    const half = Math.floor(maxButtons / 2);
    startPage = Math.max(1, currentPage - half);
    endPage = startPage + maxButtons - 1;
    if (endPage > totalPages) {
      endPage = totalPages;
      startPage = totalPages - maxButtons + 1;
    }
  }
  const pages = [];
  for (let p = startPage; p <= endPage; p += 1) pages.push({ page: p, is_current: p === currentPage });

  const pagination = {
    total,
    per_page,
    current_page: currentPage,
    total_pages: totalPages,
    prev_page: currentPage > 1 ? currentPage - 1 : null,
    next_page: currentPage < totalPages ? currentPage + 1 : null,
    pages,
  };

  const meta = {
    count: pageSlice.length,
    pagination,
    actor_id: actor.userId,
  };

  // Best-effort caching
  const payloadToCache = { meta, data: pageSlice };
  inMemSet(cacheKey, payloadToCache);
  await redisSet(cacheKey, payloadToCache, CACHE_TTL_SEC);

  c.set('cachePayload', pageSlice);
  c.header('X-Cache', 'MISS');
  return c.json({ success: true, ...meta, data: pageSlice, timestamp, traceId, actor_id: actor.userId }, 200);
};
