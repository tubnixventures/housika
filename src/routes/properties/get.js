import { getCollection } from '../../services/astra.js';
import { redis as upstashRedis } from '../../utils/auth.js';

const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 15); // short TTL by default
const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const INMEM_TTL_MS = 5000; // per-worker short cache for hot queries
const INMEM_MAX = 300;
const inMemCache = new Map(); // key -> { ts, value }

// helpers
const makeCacheKey = ({ page, limit, q, sort }) => `${CACHE_KEY_PREFIX}:properties:${page}:${limit}:${encodeURIComponent(q || '')}:${sort || ''}`;
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

const redisGet = async (key) => {
  try {
    const raw = await upstashRedis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Redis get error (properties):', e?.message || e);
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
    console.warn('Redis set error (properties):', e?.message || e);
  }
};

// Main handler
export const getProperties = async (c) => {
  const started = Date.now();
  const timestamp = new Date().toISOString();

  const rawPage = Number(c.req.query('page') || 1);
  const rawLimit = Number(c.req.query('limit') || 12);
  const q = (c.req.query('q') || '').trim();
  const sort = (c.req.query('sort') || '').trim();

  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 12;

  const cacheKey = makeCacheKey({ page, limit, q, sort });

  // 1) Try Redis
  const rCached = await redisGet(cacheKey);
  if (rCached != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.set('cachePayload', rCached.data);
    return c.json({
      success: true,
      data: rCached.data,
      total: rCached.total,
      page,
      limit,
      cached: true,
      durationMs: Date.now() - started,
      timestamp,
    }, 200);
  }

  // 2) Try in-memory
  const mem = inMemGet(cacheKey);
  if (mem != null) {
    c.header('X-Cache', 'HIT-MEM');
    c.set('cachePayload', mem.data);
    return c.json({
      success: true,
      data: mem.data,
      total: mem.total,
      page,
      limit,
      cached: true,
      durationMs: Date.now() - started,
      timestamp,
    }, 200);
  }

  // Build filter and sort
  const filter = {};
  if (q) {
    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { title: { $regex: safeQ, $options: 'i' } },
      { location: { $regex: safeQ, $options: 'i' } },
    ];
  }
  let sortObj = { createdAt: -1 };
  if (sort) {
    const desc = sort.startsWith('-');
    const key = desc ? sort.slice(1) : sort;
    sortObj = { [key]: desc ? -1 : 1 };
  }

  // Projection: return minimal fields for list
  const projection = {
    // adapt to your Astra driver projection format; this example assumes exclusion by keys
    receipt_id: 0,
    fullDescription: 0,
    largePhotos: 0,
  };

  // Connect to collection
  let propertiesCol;
  try {
    propertiesCol = await getCollection('properties');
  } catch (err) {
    console.error('DB connection error (properties):', err?.message || err);
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
    }, 503);
  }

  // Attempt server-side paged query
  try {
    const options = {
      limit,
      offset: (page - 1) * limit,
      sort: sortObj,
      projection,
    };
    const raw = await propertiesCol.find(filter, options);
    let rows = Array.isArray(raw?.data) ? raw.data : Object.values(raw?.data || {});

    const data = rows.map((item) => ({
      id: item.id || item.property_id || item._id || null,
      title: item.title || null,
      price: item.price || null,
      currency: item.price_currency || item.currency || null,
      location: item.location || null,
      thumbnail: (item.photos && item.photos[0]) || item.thumbnail || null,
      createdAt: item.createdAt || item.created_at || null,
      slug: item.slug || null,
      shortDescription: item.shortDescription || item.description || null,
    }));

    let total = typeof raw?.total === 'number' ? raw.total
      : typeof raw?.count === 'number' ? raw.count
      : null;

    if (total === null && typeof propertiesCol.count === 'function') {
      try {
        total = await propertiesCol.count(filter);
      } catch (countErr) {
        total = (page - 1) * limit + data.length;
      }
    } else if (total === null) {
      total = (page - 1) * limit + data.length;
    }

    const payload = { data, total };

    // cache best-effort
    inMemSet(cacheKey, payload);
    await redisSet(cacheKey, payload, CACHE_TTL_SEC);

    c.set('cachePayload', data);
    c.header('X-Cache', 'MISS');
    return c.json({
      success: true,
      data,
      total,
      page,
      limit,
      cached: false,
      durationMs: Date.now() - started,
      timestamp,
    }, 200);
  } catch (err) {
    // fallback: fetch all, map, sort, slice
    console.warn('Primary paged query failed, falling back:', err?.message || err);
    try {
      const rawAll = await propertiesCol.find(filter);
      let all = Array.isArray(rawAll?.data) ? rawAll.data : Object.values(rawAll?.data || {});

      const mapped = all.map((item) => ({
        id: item.id || item.property_id || item._id || null,
        title: item.title || null,
        price: item.price || null,
        currency: item.price_currency || item.currency || null,
        location: item.location || null,
        thumbnail: (item.photos && item.photos[0]) || item.thumbnail || null,
        createdAt: item.createdAt || item.created_at || null,
        slug: item.slug || null,
        shortDescription: item.shortDescription || item.description || null,
      }));

      // client-side sort
      if (sort) {
        const desc = sort.startsWith('-');
        const key = desc ? sort.slice(1) : sort;
        mapped.sort((a, b) => {
          const va = a[key] ? new Date(a[key]).getTime() : 0;
          const vb = b[key] ? new Date(b[key]).getTime() : 0;
          return desc ? vb - va : va - vb;
        });
      } else {
        mapped.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      }

      const total = mapped.length;
      const start = (page - 1) * limit;
      const pageSlice = mapped.slice(start, start + limit);

      const payload = { data: pageSlice, total };
      inMemSet(cacheKey, payload);
      await redisSet(cacheKey, payload, CACHE_TTL_SEC);

      c.set('cachePayload', pageSlice);
      c.header('X-Cache', 'MISS-FALLBACK');
      return c.json({
        success: true,
        data: pageSlice,
        total,
        page,
        limit,
        cached: false,
        durationMs: Date.now() - started,
        timestamp,
      }, 200);
    } catch (finalErr) {
      console.error('getProperties final fallback failed:', finalErr?.message || finalErr);
      return c.json({
        success: false,
        error: 'QUERY_FAILED',
        message: 'Failed to fetch properties.',
        timestamp,
      }, 500);
    }
  }
};

export default getProperties;
