import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { redis as upstashRedis } from '../../utils/auth.js';

const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 30);
const INMEM_TTL_MS = Number(process.env.INMEM_PROPERTY_TTL_MS || 15_000);
const INMEM_MAX = Number(process.env.INMEM_PROPERTY_MAX || 200);

const inMemProps = new Map(); // key -> { ts, value }
const cleanupInMem = () => {
  if (inMemProps.size <= INMEM_MAX) return;
  const keys = Array.from(inMemProps.keys()).sort((a, b) => inMemProps.get(a).ts - inMemProps.get(b).ts);
  for (let i = 0; i < Math.floor(keys.length / 4); i += 1) {
    inMemProps.delete(keys[i]);
    if (inMemProps.size <= INMEM_MAX) break;
  }
};
const inMemGet = (k) => {
  const e = inMemProps.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > INMEM_TTL_MS) {
    inMemProps.delete(k);
    return null;
  }
  return e.value;
};
const inMemSet = (k, v) => {
  inMemProps.set(k, { ts: Date.now(), value: v });
  cleanupInMem();
};

const redisGet = async (key) => {
  try {
    const raw = await upstashRedis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Redis get error (property):', e?.message || e);
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
    console.warn('Redis set error (property):', e?.message || e);
  }
};

// UUID v4 validator
const isUUID = (id) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

// lightweight projections
const projectProperty = (p) => ({
  id: p.id || p._id || p.property_id || null,
  title: p.title || p.name || null,
  location: p.location || null,
  country: p.country || null,
  thumbnail: Array.isArray(p.photos) ? p.photos[0] : p.thumbnail || null,
  createdAt: p.createdAt || p.created_at || null,
  shortDescription: p.shortDescription || p.description || null,
});

const projectRoom = (r) => ({
  id: r.id || r._id || r.room_id || null,
  title: r.title || r.name || null,
  price: r.price || null,
  currency: r.price_currency || r.currency || null,
  thumbnail: Array.isArray(r.photos) ? r.photos[0] : r.thumbnail || null,
  amenities: r.amenities || null,
  createdAt: r.createdAt || r.created_at || null,
  propertyId: r.property_id || r.propertyId || null,
});

const projectReview = (rv) => ({
  id: rv.id || rv._id || null,
  userId: rv.user_id || rv.userId || null,
  rating: rv.rating || null,
  title: rv.title || null,
  body: rv.body || rv.comment || null,
  created_at: rv.created_at || rv.createdAt || null,
});

export const getPropertyById = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID?.() || `trace-${Date.now()}`;
  const propertyId = c.req.param('id');

  if (!propertyId || !isUUID(propertyId)) {
    return c.json({
      success: false,
      error: 'INVALID_PROPERTY_ID',
      message: 'Property ID must be a valid UUID.',
      timestamp,
      traceId,
    }, 400);
  }

  const cacheKey = `${CACHE_KEY_PREFIX}:property:${propertyId}:full`;

  // 1) Try Redis cache
  const rCached = await redisGet(cacheKey);
  if (rCached != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.set('cachePayload', rCached);
    return c.json({
      success: true,
      data: rCached,
      cached: true,
      timestamp,
      traceId,
    }, 200);
  }

  // 2) Try in-memory fallback
  const mem = inMemGet(cacheKey);
  if (mem != null) {
    c.header('X-Cache', 'HIT-MEM');
    c.set('cachePayload', mem);
    return c.json({
      success: true,
      data: mem,
      cached: true,
      timestamp,
      traceId,
    }, 200);
  }

  // 3) Cache miss -> fetch from DB
  let propertiesCollection, roomsCollection, reviewsCollection;
  try {
    [propertiesCollection, roomsCollection, reviewsCollection] = await Promise.all([
      getCollection('properties'),
      getCollection('rooms'),
      getCollection('reviews'),
    ]);
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

  let propertyRaw;
  try {
    const propRes = await propertiesCollection.find({ property_id: { $eq: propertyId } });
    propertyRaw = Array.isArray(propRes?.data) ? propRes.data[0] : Object.values(propRes?.data || {})[0];

    if (!propertyRaw) {
      return c.json({
        success: false,
        error: 'PROPERTY_NOT_FOUND',
        message: `No property found with ID "${propertyId}".`,
        timestamp,
        traceId,
      }, 404);
    }
  } catch (err) {
    console.error(`❌ Property query failed for ID ${propertyId}:`, err?.message || err);
    return c.json({
      success: false,
      error: 'PROPERTY_QUERY_FAILED',
      message: 'Failed to retrieve property.',
      timestamp,
      traceId,
    }, 500);
  }

  // fetch rooms and reviews in parallel (best-effort)
  let rooms = [], reviews = [];
  try {
    const [roomRes, reviewRes] = await Promise.allSettled([
      roomsCollection.find({ property_id: { $eq: propertyId } }),
      reviewsCollection.find({ property_id: { $eq: propertyId }, status: { $eq: 'active' } }),
    ]);
    if (roomRes.status === 'fulfilled') {
      const rawRooms = Array.isArray(roomRes.value?.data) ? roomRes.value.data : Object.values(roomRes.value?.data || {});
      rooms = rawRooms.map(projectRoom);
    } else {
      console.warn('Rooms query failed (non-fatal):', roomRes.reason?.message || roomRes.reason);
    }

    if (reviewRes.status === 'fulfilled') {
      const rawReviews = Array.isArray(reviewRes.value?.data) ? reviewRes.value.data : Object.values(reviewRes.value?.data || {});
      reviews = rawReviews
        .map(projectReview)
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } else {
      console.warn('Reviews query failed (non-fatal):', reviewRes.reason?.message || reviewRes.reason);
    }
  } catch (err) {
    console.warn(`⚠️ Room/review parallel fetch had an error (non-fatal):`, err?.message || err);
  }

  // compose final payload with compact projection
  const payload = {
    property: projectProperty(propertyRaw),
    rooms,
    reviews,
  };

  // best-effort cache writes
  inMemSet(cacheKey, payload);
  await redisSet(cacheKey, payload, CACHE_TTL_SEC);

  c.set('cachePayload', payload);
  c.header('X-Cache', 'MISS');
  return c.json({
    success: true,
    data: payload,
    timestamp,
    traceId,
  }, 200);
};
