import { getCollection } from '../../services/astra.js';
import { redis as upstashRedis } from '../../utils/auth.js';

const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 30);
const CACHE_KEY = 'banners'; // hard-coded key (or include env prefix if needed)

// very small in-memory fallback cache (per-worker)
const inMemoryCache = {
  value: null,
  exp: 0,
  get() {
    if (Date.now() > this.exp) {
      this.value = null;
      return null;
    }
    return this.value;
  },
  set(v, ttlSec) {
    this.value = v;
    this.exp = Date.now() + ttlSec * 1000;
  },
};

async function getFromRedis(key) {
  try {
    const raw = await upstashRedis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    // fail-open: log and let caller use in-memory fallback
    console.warn('Redis get error (banner cache):', e?.message || e);
    return null;
  }
}

async function setToRedis(key, payload, ttlSec) {
  try {
    const raw = JSON.stringify(payload);
    await upstashRedis.set(key, raw);
    if (typeof upstashRedis.expire === 'function') {
      await upstashRedis.expire(key, ttlSec);
    }
  } catch (e) {
    console.warn('Redis set error (banner cache):', e?.message || e);
    // swallow error; in-memory fallback used instead
  }
}

export const getBanners = async (c) => {
  const timestamp = new Date().toISOString();
  const redisKey = CACHE_KEY;

  // 1) Try Redis
  const cached = await getFromRedis(redisKey);
  if (cached != null) {
    c.header('X-Cache', 'HIT');
    c.header('Cache-Control', `public, max-age=${CACHE_TTL_SEC}`);
    // ensure middleware integration: set cachePayload so server-level middleware can re-cache if needed
    c.set('cachePayload', cached);
    return c.json({
      success: true,
      count: Array.isArray(cached) ? cached.length : (cached?.length || 0),
      data: cached,
      timestamp,
      cached: true,
    });
  }

  // 2) Try in-memory fallback
  const mem = inMemoryCache.get();
  if (mem != null) {
    c.header('X-Cache', 'HIT-MEM');
    c.header('Cache-Control', `public, max-age=${CACHE_TTL_SEC}`);
    c.set('cachePayload', mem);
    return c.json({
      success: true,
      count: Array.isArray(mem) ? mem.length : (mem?.length || 0),
      data: mem,
      timestamp,
      cached: true,
    });
  }

  // 3) Cache miss: fetch from Astra
  try {
    const bannersCollection = await getCollection('banners');

    if (!bannersCollection || typeof bannersCollection.find !== 'function') {
      throw new Error('Invalid Astra DB collection: missing .find() method.');
    }

    const result = await bannersCollection.find({});
    const banners = result?.data && typeof result.data === 'object'
      ? Object.values(result.data)
      : [];

    // set caches (best-effort)
    try {
      await setToRedis(redisKey, banners, CACHE_TTL_SEC);
    } catch (_) { /* handled in setToRedis */ }
    try {
      inMemoryCache.set(banners, CACHE_TTL_SEC);
    } catch (_) { /* ignore */ }

    // expose payload for server-level caching middleware
    c.set('cachePayload', banners);

    c.header('X-Cache', 'MISS');
    c.header('Cache-Control', `public, max-age=${CACHE_TTL_SEC}`);
    return c.json({
      success: true,
      count: banners.length,
      data: banners,
      timestamp,
      cached: false,
    });
  } catch (err) {
    console.error('❌ Error fetching banners:', err?.message || err);
    return c.json(
      {
        success: false,
        error: 'FETCH_ERROR',
        message: 'Unable to retrieve banners at this time.',
        timestamp,
      },
      500
    );
  }
};
