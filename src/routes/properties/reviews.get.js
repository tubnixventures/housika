import { getCollection } from '../../services/astra.js';
import { redis as upstashRedis } from '../../utils/auth.js';

const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 30); // TTL for reviews cache
const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const INMEM_TTL_MS = Number(process.env.INMEM_REVIEWS_TTL_MS || 5000); // per-worker fallback
const INMEM_MAX = Number(process.env.INMEM_REVIEWS_MAX || 500);

const inMemReviews = new Map(); // key -> { ts, value }
const cleanupInMem = () => {
  if (inMemReviews.size <= INMEM_MAX) return;
  const keys = Array.from(inMemReviews.keys()).sort((a, b) => inMemReviews.get(a).ts - inMemReviews.get(b).ts);
  for (let i = 0; i < Math.floor(keys.length / 4); i += 1) {
    inMemReviews.delete(keys[i]);
    if (inMemReviews.size <= INMEM_MAX) break;
  }
};
const inMemGet = (k) => {
  const e = inMemReviews.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > INMEM_TTL_MS) {
    inMemReviews.delete(k);
    return null;
  }
  return e.value;
};
const inMemSet = (k, v) => {
  inMemReviews.set(k, { ts: Date.now(), value: v });
  cleanupInMem();
};

const redisGet = async (key) => {
  try {
    const raw = await upstashRedis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Redis get error (reviews):', e?.message || e);
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
    console.warn('Redis set error (reviews):', e?.message || e);
  }
};

export async function getReviews(c) {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || `trace-${Date.now()}`;

  const propertyId = c.req.query('property_id');
  if (!propertyId) {
    return c.json({
      success: false,
      error: 'MISSING_PROPERTY_ID',
      message: 'property_id is required.',
      traceId,
      timestamp,
    }, 400);
  }

  // optional pagination (safe defaults)
  const rawPage = Number(c.req.query('page') || 1);
  const rawLimit = Number(c.req.query('limit') || 20);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 20;
  const offset = (page - 1) * limit;

  const cacheKey = `${CACHE_KEY_PREFIX}:reviews:${propertyId}:p${page}:l${limit}`;

  // 1) Try Redis
  const rCached = await redisGet(cacheKey);
  if (rCached != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.set('cachePayload', rCached.reviews);
    return c.json({
      success: true,
      reviews: rCached.reviews,
      count: rCached.count,
      page,
      limit,
      cached: true,
      traceId,
      timestamp,
    }, 200);
  }

  // 2) Try in-memory fallback
  const mem = inMemGet(cacheKey);
  if (mem != null) {
    c.header('X-Cache', 'HIT-MEM');
    c.set('cachePayload', mem.reviews);
    return c.json({
      success: true,
      reviews: mem.reviews,
      count: mem.count,
      page,
      limit,
      cached: true,
      traceId,
      timestamp,
    }, 200);
  }

  // 3) Cache miss -> fetch from DB
  try {
    const reviewsCol = await getCollection('reviews');
    if (!reviewsCol || typeof reviewsCol.find !== 'function') {
      throw new Error('Invalid reviews collection: missing find method');
    }

    // Build filter: active reviews for propertyId
    const filter = {
      property_id: { $eq: propertyId },
      status: { $eq: 'active' },
    };

    // Try server-side paged find if supported
    let raw;
    try {
      raw = await reviewsCol.find(filter, { limit, offset, sort: { created_at: -1 } });
    } catch (e) {
      // fallback to unpaged fetch if driver doesn't support options
      raw = await reviewsCol.find(filter);
    }

    // Normalize data
    let rows = Array.isArray(raw?.data) ? raw.data : Object.values(raw?.data || {});
    // If unpaged and we requested pagination, slice here
    if (!raw?.data || !Array.isArray(raw.data)) {
      rows = rows.sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0));
      rows = rows.slice(offset, offset + limit);
    }

    // Map to compact shape
    const reviews = rows.map((r) => ({
      id: r.id || r._id || null,
      userId: r.user_id || r.userId || null,
      rating: r.rating || null,
      title: r.title || null,
      body: r.body || r.comment || null,
      created_at: r.created_at || r.createdAt || null,
    }));

    const count = Array.isArray(raw?.data) ? (typeof raw.total === 'number' ? raw.total : (offset + reviews.length)) : reviews.length;

    const payload = { reviews, count };

    // Best-effort caches
    inMemSet(cacheKey, payload);
    await redisSet(cacheKey, payload, CACHE_TTL_SEC);

    c.set('cachePayload', reviews);
    c.header('X-Cache', 'MISS');
    return c.json({
      success: true,
      reviews,
      count,
      page,
      limit,
      cached: false,
      traceId,
      timestamp,
    }, 200);
  } catch (err) {
    console.error('❌ Review fetch failed:', err?.message || err);
    return c.json({
      success: false,
      error: 'REVIEW_FETCH_FAILED',
      message: 'Unable to retrieve reviews.',
      traceId,
      timestamp,
    }, 500);
  }
}
