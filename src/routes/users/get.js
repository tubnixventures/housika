import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken, redis as upstashRedis } from '../../utils/auth.js';

const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 15); // short TTL for user list queries
const INMEM_TTL_MS = Number(process.env.INMEM_USERS_TTL_MS || 5000);
const INMEM_MAX = Number(process.env.INMEM_USERS_MAX || 300);

const HIERARCHY = ['real estate company', 'landlord', 'dual', 'customer care', 'admin', 'ceo'];

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

// simple per-worker in-memory cache (small, short-lived)
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

// Redis helpers (best-effort; fail-open)
const redisGet = async (key) => {
  try {
    const raw = await upstashRedis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Redis get error (users):', e?.message || e);
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
    console.warn('Redis set error (users):', e?.message || e);
  }
};

// deterministic cache key for query + visibleRoles
const makeCacheKey = ({ visibleRoles, page, pageSize, email, phonenumber, role, search }) => {
  const parts = [
    `${CACHE_KEY_PREFIX}:users`,
    `roles=${visibleRoles.join(',')}`,
    `p=${page}`,
    `ps=${pageSize}`,
  ];
  if (email) parts.push(`email=${encodeURIComponent(String(email))}`);
  if (phonenumber) parts.push(`phone=${encodeURIComponent(String(phonenumber))}`);
  if (role) parts.push(`role=${encodeURIComponent(String(role))}`);
  if (search) parts.push(`q=${encodeURIComponent(String(search).slice(0, 128))}`); // cap length
  return parts.join('|');
};

// lightweight projection to reduce payload and cache size
const projectUser = (u) => ({
  id: u.id || u._id || null,
  fullname: u.fullname || u.name || null,
  email: u.email || null,
  phonenumber: u.phonenumber || u.phone || null,
  role: u.role || null,
  created_at: u.created_at || u.createdAt || null,
  organization: u.organization || u.company || null,
});

export const getUsers = async (c) => {
  const start = Date.now();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID?.() || `trace-${Date.now()}`;
  const token = c.req.header('Authorization')?.replace('Bearer ', '') || '';
  const timestamp = new Date().toISOString();

  // Auth guard
  if (!token) {
    return c.json({
      success: false,
      error: 'MISSING_TOKEN',
      message: 'Missing authentication token.',
      timestamp,
      traceId,
    }, 401);
  }

  const actor = await checkToken(token).catch((err) => {
    console.error('❌ Token check failed:', err?.message || err);
    return null;
  });

  if (!actor?.role) {
    return c.json({
      success: false,
      error: 'INVALID_TOKEN',
      message: 'Invalid or expired token.',
      timestamp,
      traceId,
    }, 401);
  }

  const actorRank = HIERARCHY.indexOf(actor.role);
  if (actorRank === -1) {
    return c.json({
      success: false,
      error: 'ROLE_UNKNOWN',
      message: 'Your role is not recognized in the hierarchy.',
      timestamp,
      traceId,
    }, 400);
  }

  // Parse query params
  const qObj = Object.fromEntries(c.req.query());
  const page = parsePositiveInt(qObj.page, 1);
  const pageSizeRaw = parsePositiveInt(qObj.pageSize || qObj.page_size || qObj.limit, 10);
  const pageSize = Math.min(Math.max(pageSizeRaw, 1), 100);

  const email = qObj.email;
  const phonenumber = qObj.phonenumber || qObj.phone;
  const role = qObj.role;
  const search = qObj.search ? String(qObj.search).trim() : '';

  // Determine visible roles for this actor
  const visibleRoles = actor.role === 'ceo' ? HIERARCHY.slice() : HIERARCHY.slice(0, actorRank + 1);

  // Validate requested role filter is within visibility
  if (role && !visibleRoles.includes(role)) {
    return c.json({
      success: false,
      error: 'FORBIDDEN_ROLE_FILTER',
      message: 'You cannot filter for roles outside your visibility.',
      timestamp,
      traceId,
    }, 403);
  }

  const cacheKey = makeCacheKey({ visibleRoles, page, pageSize, email, phonenumber, role, search });

  // Try Redis
  const rCached = await redisGet(cacheKey);
  if (rCached != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.set('cachePayload', rCached.data);
    return c.json({
      success: true,
      ...rCached.meta,
      data: rCached.data,
      cached: true,
      timestamp,
      traceId,
      duration: `${Date.now() - start}ms`,
    }, 200);
  }

  // Try in-memory
  const mem = inMemGet(cacheKey);
  if (mem != null) {
    c.header('X-Cache', 'HIT-MEM');
    c.set('cachePayload', mem.data);
    return c.json({
      success: true,
      ...mem.meta,
      data: mem.data,
      cached: true,
      timestamp,
      traceId,
      duration: `${Date.now() - start}ms`,
    }, 200);
  }

  // Build base query
  const baseQuery = { role: { $in: visibleRoles } };
  if (email) baseQuery.email = { $eq: email };
  if (phonenumber) baseQuery.phonenumber = { $eq: phonenumber };
  if (role) baseQuery.role = { $eq: role };

  // Connect to users collection
  let usersCollection;
  try {
    usersCollection = await getCollection('users');
  } catch (err) {
    console.error('❌ DB connection error:', err?.message || err);
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  // Attempt collection-level pagination (best-effort)
  try {
    if (typeof usersCollection.find === 'function') {
      const findOptions = { limit: pageSize, offset: (page - 1) * pageSize, sort: { created_at: -1 } };
      // Let SDK ignore unknown options if unsupported
      const result = await usersCollection.find(baseQuery, findOptions).catch(() => null);

      if (result) {
        // normalize rows
        const rows = Array.isArray(result.data) ? result.data : Object.values(result?.data || {});
        // client-side search if requested (cheap for small page sizes)
        const projected = rows.map(projectUser);
        let filtered = projected;
        if (search) {
          const s = search.toLowerCase();
          filtered = projected.filter(u =>
            (u.fullname || '').toLowerCase().includes(s) ||
            (u.email || '').toLowerCase().includes(s) ||
            (u.phonenumber || '').toLowerCase().includes(s)
          );
        }

        const total = typeof result.total === 'number' ? result.total : null;
        const computedTotal = total ?? null;
        const meta = {
          count: filtered.length,
          page,
          pageSize,
          total: computedTotal,
          totalPages: computedTotal ? Math.max(1, Math.ceil(computedTotal / pageSize)) : null,
          hasNext: computedTotal ? page < Math.max(1, Math.ceil(computedTotal / pageSize)) : null,
          hasPrev: page > 1,
          visibleRoles,
        };

        // cache result (best-effort)
        const payloadToCache = { meta, data: filtered };
        inMemSet(cacheKey, payloadToCache);
        await redisSet(cacheKey, payloadToCache, CACHE_TTL_SEC);

        c.set('cachePayload', filtered);
        c.header('X-Cache', 'MISS');
        return c.json({
          success: true,
          ...meta,
          data: filtered,
          timestamp,
          traceId,
          duration: `${Date.now() - start}ms`,
        }, 200);
      }
    }
  } catch (err) {
    console.warn('⚠️ Collection-level pagination attempt failed, falling back:', err?.message || err);
  }

  // Manual fallback: fetch all restricted documents, apply search, sort, slice
  try {
    const lookupResult = await usersCollection.find(baseQuery);
    const allUsers = Array.isArray(lookupResult?.data) ? lookupResult.data : Object.values(lookupResult?.data || {});

    // Map then filter/search (map first to reduce memory if original docs large)
    let mapped = allUsers.map(projectUser);

    if (search) {
      const s = search.toLowerCase();
      mapped = mapped.filter(u =>
        (u.fullname || '').toLowerCase().includes(s) ||
        (u.email || '').toLowerCase().includes(s) ||
        (u.phonenumber || '').toLowerCase().includes(s)
      );
    }

    // sort newest first
    mapped.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    const total = mapped.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(page, 1), totalPages);
    const startIdx = (safePage - 1) * pageSize;
    const pageSlice = mapped.slice(startIdx, startIdx + pageSize);

    const meta = {
      count: pageSlice.length,
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
      visibleRoles,
    };

    const payloadToCache = { meta, data: pageSlice };
    inMemSet(cacheKey, payloadToCache);
    await redisSet(cacheKey, payloadToCache, CACHE_TTL_SEC);

    c.set('cachePayload', pageSlice);
    c.header('X-Cache', 'MISS-FALLBACK');
    return c.json({
      success: true,
      ...meta,
      data: pageSlice,
      timestamp,
      traceId,
      duration: `${Date.now() - start}ms`,
    }, 200);
  } catch (err) {
    console.error('❌ User query failed:', err?.message || err);
    if (err.response?.data) {
      console.error('📄 Astra error response:', JSON.stringify(err.response.data, null, 2));
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to fetch users.',
      timestamp,
      traceId,
    }, 500);
  }
};
