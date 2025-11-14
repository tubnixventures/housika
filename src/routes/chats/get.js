import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { redis as upstashRedis } from '../../utils/auth.js';

const CHAT_COLLECTION = 'chats';
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
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 15); // short TTL for chat list pages
const INMEM_TTL_MS = Number(process.env.INMEM_CHATS_TTL_MS || 5000);
const INMEM_MAX = Number(process.env.INMEM_CHATS_MAX || 200);

// in-process fallback cache (per-worker)
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
    console.warn('Redis get error (chats):', e?.message || e);
    return null;
  }
};
const redisSet = async (key, payload, ttlSec = CACHE_TTL_SEC) => {
  try {
    await upstashRedis.set(key, JSON.stringify(payload));
    if (typeof upstashRedis.expire === 'function') await upstashRedis.expire(key, ttlSec);
  } catch (e) {
    console.warn('Redis set error (chats):', e?.message || e);
  }
};

// compact projection for chat and message
const projectChat = (ch) => ({
  id: ch.id || ch._id || ch.chatId || null,
  name: ch.name || null,
  tenantId: ch.tenantId || null,
  participants: Array.isArray(ch.participants) ? ch.participants.map(p => ({ userId: p.userId, role: p.role })) : [],
  createdAt: ch.createdAt || ch.created_at || null,
  updatedAt: ch.updatedAt || ch.updated_at || null,
});
const projectMessage = (m) => m ? ({
  id: m.id || m._id || m.messageId || null,
  chatId: m.chatId || m.chat_id || null,
  senderId: m.senderId || m.sender_id || null,
  body: m.body || m.text || null,
  createdAt: m.createdAt || m.created_at || null,
}) : null;

const makeCacheKey = ({ tenantId, participantId, page, limit, since }) => {
  const parts = [
    `${CACHE_KEY_PREFIX}:chats`,
    `t=${tenantId || 'any'}`,
    `p=${participantId || 'any'}`,
    `pg=${page}`,
    `l=${limit}`,
    `s=${since || ''}`,
  ];
  return parts.join('|');
};

export const getChats = async (c) => {
  const timestamp = nowIso();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID?.() || `trace-${Date.now()}`;
  const log = makeLogger(traceId);

  // Basic auth/tenant inference (replace with real auth integration if present)
  const authUser = c.state?.user || null;
  const authUserId = authUser?.id || c.req.header('x-user-id') || null;

  // Query params (use c.req.query() if Hono exposes method; older code uses object)
  const q = Object.fromEntries(typeof c.req.query === 'function' ? c.req.query() : (c.req.query || {}));
  const tenantId = q.tenantId || authUser?.tenantId || null;
  const participantId = q.participantId || null;
  let limit = parseInt(q.limit, 10) || DEFAULT_LIMIT;
  let page = Math.max(1, parseInt(q.page, 10) || 1);
  const since = q.since || null;

  if (limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  // Build chat filter
  const chatFilter = {};
  if (tenantId) chatFilter.tenantId = { $eq: tenantId };
  if (participantId) chatFilter['participants.userId'] = { $eq: participantId };
  if (since) {
    const d = new Date(since);
    if (!isNaN(d)) chatFilter.updatedAt = { $gte: d.toISOString() };
  }

  const cacheKey = makeCacheKey({ tenantId, participantId, page, limit, since });

  // Try caches (Redis -> in-memory)
  const rCached = await redisGet(cacheKey);
  if (rCached != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.set('cachePayload', rCached.data);
    return c.json({ success: true, meta: rCached.meta, data: rCached.data, timestamp, traceId }, 200);
  }
  const mem = inMemGet(cacheKey);
  if (mem != null) {
    c.header('X-Cache', 'HIT-MEM');
    c.set('cachePayload', mem.data);
    return c.json({ success: true, meta: mem.meta, data: mem.data, timestamp, traceId }, 200);
  }

  // Resolve collections
  let chatsCol, messagesCol;
  try {
    const [chatsResult, messagesResult] = await Promise.allSettled([
      getCollection(CHAT_COLLECTION),
      getCollection(MESSAGE_COLLECTION),
    ]);
    chatsCol = chatsResult.status === 'fulfilled' ? chatsResult.value : null;
    messagesCol = messagesResult.status === 'fulfilled' ? messagesResult.value : null;
    if (!chatsCol || !messagesCol) {
      log.error('DB collection retrieval failed', {
        chatsReason: chatsResult.reason,
        messagesReason: messagesResult.reason,
      });
      return c.json({ success: false, error: 'DB_CONNECTION_FAILED', message: 'Unable to reach database.', timestamp, traceId }, 503);
    }
  } catch (err) {
    log.error('Unexpected DB connection error', { err: err?.message || err });
    return c.json({ success: false, error: 'DB_CONNECTION_FAILED', message: 'Unable to reach database.', timestamp, traceId }, 503);
  }

  // Fetch chats page (compact projection)
  let chatsPage = [];
  let totalCount = 0;
  try {
    const skip = (page - 1) * limit;
    const projection = { name: 1, tenantId: 1, participants: 1, createdAt: 1, updatedAt: 1 };
    // adapt options shape to your Astra driver: many support { limit, offset, sort, projection } or { limit, skip }
    const result = await chatsCol.find(chatFilter, { limit, offset: skip, sort: { updatedAt: -1 }, projection }).catch(async () => {
      // fallback: try older option name skip
      return await chatsCol.find(chatFilter, { limit, skip, sort: { updatedAt: -1 }, projection });
    });
    chatsPage = Array.isArray(result?.data) ? result.data : Object.values(result?.data || {});
    totalCount = typeof result?.total === 'number' ? result.total : (Array.isArray(result?.data) ? result.data.length : chatsPage.length);
  } catch (err) {
    log.error('Chat query failed', { err: err?.message || err });
    return c.json({ success: false, error: 'DB_QUERY_FAILED', message: 'Unable to retrieve chats at this time.', timestamp, traceId }, 500);
  }

  // For each chat, fetch the newest message concurrently (limit concurrency if needed)
  const fetchLatestForChat = async (chat) => {
    try {
      const chatId = chat.id || chat._id || chat.chatId;
      // adjust message query shape for your driver
      const msgRes = await messagesCol.find({ chatId: { $eq: chatId } }, { sort: { createdAt: -1 }, limit: 1 }).catch(async () => {
        return await messagesCol.find({ chatId: { $eq: chatId } }, { sort: { createdAt: -1 }, limit: 1 });
      });
      const msgs = Array.isArray(msgRes?.data) ? msgRes.data : Object.values(msgRes?.data || {});
      const latest = msgs[0] || null;
      return { ...projectChat(chat), latestMessage: projectMessage(latest) };
    } catch (err) {
      log.warn('Failed to fetch latest message for chat', { chatId: chat.id || chat._id, err: err?.message || err });
      return { ...projectChat(chat), latestMessage: null };
    }
  };

  let chatsWithLatest;
  try {
    // Parallelize with Promise.all. If you expect many chats and want bounded concurrency, replace with a small worker pool.
    const promises = chatsPage.map(fetchLatestForChat);
    chatsWithLatest = await Promise.all(promises);
  } catch (err) {
    log.error('Failed while fetching latest messages', { err: err?.message || err });
    return c.json({ success: false, error: 'MESSAGE_LOOKUP_FAILED', message: 'Failed to retrieve latest messages.', timestamp, traceId }, 500);
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const meta = { page, limit, totalCount, totalPages, returned: chatsWithLatest.length };

  // Best-effort caching
  const payloadToCache = { meta, data: chatsWithLatest };
  inMemSet(cacheKey, payloadToCache);
  await redisSet(cacheKey, payloadToCache, CACHE_TTL_SEC);

  c.set('cachePayload', chatsWithLatest);
  c.header('X-Cache', 'MISS');
  return c.json({ success: true, meta, data: chatsWithLatest, timestamp, traceId }, 200);
};
