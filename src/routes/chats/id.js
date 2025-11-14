import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { redis as upstashRedis } from '../../utils/auth.js';

const MESSAGE_COLLECTION = 'messages';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function nowIso() { return new Date().toISOString(); }
function makeLogger(traceId) {
  return {
    info: (...args) => console.info({ traceId, ts: nowIso(), pid: process.pid }, ...args),
    warn: (...args) => console.warn({ traceId, ts: nowIso(), pid: process.pid }, ...args),
    error: (...args) => console.error({ traceId, ts: nowIso(), pid: process.pid }, ...args),
  };
}

// Cache config
const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 15); // short TTL for message pages
const INMEM_TTL_MS = Number(process.env.INMEM_MESSAGES_TTL_MS || 5000);
const INMEM_MAX = Number(process.env.INMEM_MESSAGES_MAX || 500);

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
  if (Date.now() - e.ts > INMEM_TTL_MS) { inMemCache.delete(k); return null; }
  return e.value;
};
const inMemSet = (k, v) => { inMemCache.set(k, { ts: Date.now(), value: v }); cleanupInMem(); };

// Redis helpers (best-effort)
const redisGet = async (key) => {
  try {
    const raw = await upstashRedis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Redis get error (messages):', e?.message || e);
    return null;
  }
};
const redisSet = async (key, payload, ttlSec = CACHE_TTL_SEC) => {
  try {
    await upstashRedis.set(key, JSON.stringify(payload));
    if (typeof upstashRedis.expire === 'function') await upstashRedis.expire(key, ttlSec);
  } catch (e) {
    console.warn('Redis set error (messages):', e?.message || e);
  }
};

// compact projection for messages
const projection = { chatId: 1, body: 1, type: 1, createdAt: 1, createdBy: 1, metadata: 1 };

// deterministic cache key for chat paging
const makeCacheKey = ({ chatId, tenantId, participantId, limit, page, cursor, order }) => {
  const parts = [
    `${CACHE_KEY_PREFIX}:messages`,
    `chat=${chatId}`,
    `t=${tenantId || 'any'}`,
    `p=${participantId || 'any'}`,
    `l=${limit}`,
    `pg=${page || 1}`,
    `c=${cursor || ''}`,
    `o=${order === -1 ? 'desc' : 'asc'}`,
  ];
  return parts.join('|');
};

export const getMessagesForChat = async (c) => {
  const timestamp = nowIso();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID?.() || `trace-${Date.now()}`;
  const log = makeLogger(traceId);

  // Validate route param
  const chatId = c.req.param('id');
  if (!chatId || typeof chatId !== 'string') {
    log.warn('Invalid chat id', { chatId });
    return c.json({ success: false, error: 'INVALID_CHAT_ID', message: 'Chat ID must be a valid string.', timestamp, traceId }, 400);
  }

  // Auth / tenant inference (integrate real auth if present)
  const authUser = c.state?.user || null;
  const authUserId = authUser?.id || c.req.header('x-user-id') || null;
  const tenantId = authUser?.tenantId || c.req.header('x-tenant-id') || null;

  // Parse query params (Hono provides c.req.query())
  const qObj = typeof c.req.query === 'function' ? Object.fromEntries(c.req.query()) : (c.req.query || {});
  const rawLimit = Number(qObj.limit || qObj.pageSize || DEFAULT_LIMIT);
  let limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const page = Math.max(1, Number(qObj.page) ? Math.floor(Number(qObj.page)) : 1);
  const cursor = qObj.cursor || null; // ISO createdAt string used as cursor
  const order = qObj.order === 'desc' ? -1 : 1; // 1 => asc, -1 => desc
  const sortOption = { createdAt: order };

  // Build filter with chatId and scoping
  const filter = { chatId: { $eq: chatId } };
  if (tenantId) filter.tenantId = { $eq: tenantId };
  if (qObj.participantId) filter['participants.userId'] = { $eq: qObj.participantId };
  // Enforce participant check if authUserId present and no explicit participantId
  if (authUserId && !qObj.participantId) filter['participants.userId'] = { $eq: authUserId };

  // Build cache key
  const cacheKey = makeCacheKey({ chatId, tenantId, participantId: qObj.participantId, limit, page, cursor, order });

  // Try caches
  const rCached = await redisGet(cacheKey);
  if (rCached != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.set('cachePayload', rCached.data);
    return c.json({ success: true, chatId, meta: rCached.meta, data: rCached.data, timestamp, traceId }, 200);
  }
  const mem = inMemGet(cacheKey);
  if (mem != null) {
    c.header('X-Cache', 'HIT-MEM');
    c.set('cachePayload', mem.data);
    return c.json({ success: true, chatId, meta: mem.meta, data: mem.data, timestamp, traceId }, 200);
  }

  // Resolve collection
  let messagesCol;
  try {
    messagesCol = await getCollection(MESSAGE_COLLECTION);
    if (!messagesCol || typeof messagesCol.find !== 'function') throw new Error('messages collection unavailable');
  } catch (err) {
    log.error('DB connection failed', { err: err?.message || err });
    return c.json({ success: false, error: 'DB_CONNECTION_FAILED', message: 'Database connection failed.', timestamp, traceId }, 503);
  }

  // Prepare find options
  const findOptions = { projection, sort: sortOption, limit };
  const skip = cursor ? 0 : (page - 1) * limit;
  if (!cursor) findOptions.offset = skip; // many drivers use offset; adapt to 'skip' if needed

  // If cursor provided, convert to createdAt filter for stable paging
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (!isNaN(cursorDate)) {
      filter.createdAt = order === 1 ? { $gt: cursorDate.toISOString() } : { $lt: cursorDate.toISOString() };
    } else {
      log.warn('Invalid cursor ignored', { cursor });
    }
  }

  // Execute query
  let messages = [];
  let total = null;
  try {
    // Try common option names; fall back as needed depending on driver
    let result;
    try {
      result = await messagesCol.find(filter, findOptions);
    } catch (e) {
      // driver might expect { limit, skip } instead of offset
      const fallbackOptions = { ...findOptions, skip };
      result = await messagesCol.find(filter, fallbackOptions);
    }

    messages = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : Object.values(result?.data || {});
    if (typeof result?.total === 'number') total = result.total;
  } catch (err) {
    log.error('Message query failed', { err: err?.message || err, filter, limit, page });
    return c.json({ success: false, error: 'DB_QUERY_FAILED', message: 'Failed to retrieve chat messages.', timestamp, traceId }, 500);
  }

  // Build nextCursor for cursor paging (use last item's createdAt)
  let nextCursor = null;
  if (messages.length === limit) {
    const last = messages[messages.length - 1];
    nextCursor = last?.createdAt || null;
  }

  // Normalize messages (ensure minimal fields) — map if necessary
  const normalized = messages.map((m) => ({
    id: m.id || m._id || null,
    chatId: m.chatId || m.chat_id || null,
    body: m.body || m.text || null,
    type: m.type || null,
    createdAt: m.createdAt || m.created_at || null,
    createdBy: m.createdBy || m.created_by || null,
    metadata: m.metadata || null,
  }));

  const meta = {
    returned: normalized.length,
    limit,
    page,
    nextCursor,
    total,
    order: order === 1 ? 'asc' : 'desc',
  };

  // Best-effort caching of this page
  const payloadToCache = { meta, data: normalized };
  inMemSet(cacheKey, payloadToCache);
  await redisSet(cacheKey, payloadToCache, CACHE_TTL_SEC);

  c.set('cachePayload', normalized);
  c.header('X-Cache', 'MISS');
  return c.json({ success: true, chatId, meta, data: normalized, timestamp, traceId }, 200);
};
