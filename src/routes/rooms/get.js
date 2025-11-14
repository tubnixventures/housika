import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { redis as upstashRedis } from '../../utils/auth.js';

const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 30);
const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const INMEM_TTL_MS = Number(process.env.INMEM_ROOMS_TTL_MS || 5000);
const INMEM_MAX = Number(process.env.INMEM_ROOMS_MAX || 200);

const inMemRooms = new Map(); // key -> { ts, value }
const cleanupInMem = () => {
  if (inMemRooms.size <= INMEM_MAX) return;
  const keys = Array.from(inMemRooms.keys()).sort((a, b) => inMemRooms.get(a).ts - inMemRooms.get(b).ts);
  for (let i = 0; i < Math.floor(keys.length / 4); i += 1) {
    inMemRooms.delete(keys[i]);
    if (inMemRooms.size <= INMEM_MAX) break;
  }
};
const inMemGet = (k) => {
  const e = inMemRooms.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > INMEM_TTL_MS) {
    inMemRooms.delete(k);
    return null;
  }
  return e.value;
};
const inMemSet = (k, v) => {
  inMemRooms.set(k, { ts: Date.now(), value: v });
  cleanupInMem();
};

const redisGet = async (key) => {
  try {
    const raw = await upstashRedis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Redis get error (rooms):', e?.message || e);
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
    console.warn('Redis set error (rooms):', e?.message || e);
  }
};

export const getRooms = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID?.() || `trace-${Date.now()}`;
  const start = Date.now();

  const cacheKey = `${CACHE_KEY_PREFIX}:rooms:all`;

  // 1) Try Redis cache
  const rCached = await redisGet(cacheKey);
  if (rCached != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.set('cachePayload', rCached);
    return c.json({
      success: true,
      count: Array.isArray(rCached) ? rCached.length : (rCached?.length || 0),
      data: rCached,
      timestamp,
      traceId,
      cached: true,
      durationMs: Date.now() - start,
    });
  }

  // 2) Try in-memory fallback
  const mem = inMemGet(cacheKey);
  if (mem != null) {
    c.header('X-Cache', 'HIT-MEM');
    c.set('cachePayload', mem);
    return c.json({
      success: true,
      count: Array.isArray(mem) ? mem.length : (mem?.length || 0),
      data: mem,
      timestamp,
      traceId,
      cached: true,
      durationMs: Date.now() - start,
    });
  }

  // 3) Cache miss -> fetch DB
  try {
    const roomsCollection = await getCollection('rooms');
    if (!roomsCollection || typeof roomsCollection.find !== 'function') {
      throw new Error('Collection "rooms" missing .find() method.');
    }

    const result = await roomsCollection.find({});
    const rooms = Array.isArray(result?.data) ? result.data : Object.values(result?.data || {});

    // lightweight projection: keep only commonly used fields to reduce payload and cache size
    const mapped = rooms.map((r) => ({
      id: r.id || r._id || r.room_id || null,
      title: r.title || r.name || null,
      price: r.price || null,
      currency: r.price_currency || r.currency || null,
      photos: Array.isArray(r.photos) ? r.photos.slice(0, 3) : (r.photos ? [r.photos] : []),
      amenities: r.amenities || null,
      createdAt: r.createdAt || r.created_at || null,
      propertyId: r.property_id || r.propertyId || null,
      shortDescription: r.shortDescription || r.description || null,
    }));

    // best-effort cache writes
    inMemSet(cacheKey, mapped);
    await redisSet(cacheKey, mapped, CACHE_TTL_SEC);

    console.log(`✅ /rooms fetched ${mapped.length} items in ${Date.now() - start}ms`);

    c.set('cachePayload', mapped);
    return c.json({
      success: true,
      count: mapped.length,
      data: mapped,
      timestamp,
      traceId,
      cached: false,
      durationMs: Date.now() - start,
    });
  } catch (err) {
    const isConnectionError = String(err?.message || '').includes('Collection') || String(err?.message || '').includes('setup');
    const status = isConnectionError ? 503 : 500;
    const errorCode = isConnectionError ? 'DB_CONNECTION_FAILED' : 'DB_QUERY_FAILED';
    const message = isConnectionError ? 'Database connection failed.' : 'Failed to fetch rooms.';

    console.error(`❌ ${errorCode}:`, err?.message || err);
    if (err.response?.data) {
      console.error('📄 Astra error response:', JSON.stringify(err.response.data, null, 2));
    }

    return c.json({
      success: false,
      error: errorCode,
      message,
      timestamp,
      traceId,
    }, status);
  }
};
