import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { redis as upstashRedis } from '../../utils/auth.js';

const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 30);
const INMEM_TTL_MS = Number(process.env.INMEM_ROOM_TTL_MS || 15_000);
const INMEM_MAX = Number(process.env.INMEM_ROOM_MAX || 100);

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
    console.warn('Redis get error (room):', e?.message || e);
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
    console.warn('Redis set error (room):', e?.message || e);
  }
};

const projectRoom = (r) => ({
  id: r.id || r._id || r.room_id || null,
  title: r.title || r.name || null,
  price: r.price || null,
  currency: r.price_currency || r.currency || null,
  photos: Array.isArray(r.photos) ? r.photos.slice(0, 5) : (r.photos ? [r.photos] : []),
  amenities: r.amenities || null,
  createdAt: r.createdAt || r.created_at || null,
  propertyId: r.property_id || r.propertyId || null,
  description: r.shortDescription || r.description || null,
});

export const getRoomById = async (c) => {
  const timestamp = new Date().toISOString();
  const roomId = c.req.param('id');
  const withProperty = c.req.query('withProperty') === 'true';
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID?.() || `trace-${Date.now()}`;
  const start = Date.now();

  if (!roomId || typeof roomId !== 'string') {
    return c.json({
      success: false,
      error: 'INVALID_ROOM_ID',
      message: 'Room ID is required and must be a string.',
      timestamp,
      traceId,
    }, 400);
  }

  const cacheKey = `${CACHE_KEY_PREFIX}:room:${roomId}:withProperty:${withProperty ? '1' : '0'}`;

  // 1) Try Redis
  const rCached = await redisGet(cacheKey);
  if (rCached != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.set('cachePayload', rCached);
    return c.json({
      success: true,
      room: rCached,
      cached: true,
      durationMs: Date.now() - start,
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
      room: mem,
      cached: true,
      durationMs: Date.now() - start,
      timestamp,
      traceId,
    }, 200);
  }

  // 3) Cache miss -> fetch from DB
  let roomsCollection;
  let propertiesCollection = null;
  try {
    roomsCollection = await getCollection('rooms');
    if (!roomsCollection || typeof roomsCollection.find !== 'function') {
      throw new Error('Collection "rooms" missing .find() method.');
    }
    if (withProperty) {
      propertiesCollection = await getCollection('properties');
      if (!propertiesCollection || typeof propertiesCollection.find !== 'function') {
        // allow room response even if property enrichment can't be established
        propertiesCollection = null;
        console.warn('Properties collection not available for enrichment');
      }
    }
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

  try {
    // Primary: try targeted find by id (driver-dependent)
    // Many Astra wrappers support equality query; adjust if your driver needs different shape
    const result = await roomsCollection.find({ room_id: { $eq: roomId } });
    const roomRaw = Array.isArray(result?.data) ? result.data[0] : Object.values(result?.data || {})[0];

    if (!roomRaw) {
      return c.json({
        success: false,
        error: 'ROOM_NOT_FOUND',
        message: `No room found with ID "${roomId}".`,
        timestamp,
        traceId,
      }, 404);
    }

    // Map to compact shape
    const room = projectRoom(roomRaw);

    // If enrichment requested and propertyId exists, fetch property (best-effort, non-fatal)
    if (withProperty && room.propertyId && propertiesCollection) {
      try {
        const propRes = await propertiesCollection.find({ property_id: { $eq: room.propertyId } });
        const propertyRaw = Array.isArray(propRes?.data) ? propRes.data[0] : Object.values(propRes?.data || {})[0];
        if (propertyRaw) {
          // small projection on property
          room.property = {
            id: propertyRaw.id || propertyRaw._id || propertyRaw.property_id || null,
            title: propertyRaw.title || propertyRaw.name || null,
            location: propertyRaw.location || null,
            thumbnail: Array.isArray(propertyRaw.photos) ? propertyRaw.photos[0] : propertyRaw.thumbnail || null,
            createdAt: propertyRaw.createdAt || propertyRaw.created_at || null,
          };
        }
      } catch (propErr) {
        console.warn('⚠️ Property enrichment failed (non-fatal):', propErr?.message || propErr);
      }
    }

    // Best-effort caching
    inMemSet(cacheKey, room);
    await redisSet(cacheKey, room, CACHE_TTL_SEC);

    c.set('cachePayload', room);
    c.header('X-Cache', 'MISS');
    return c.json({
      success: true,
      room,
      cached: false,
      durationMs: Date.now() - start,
      timestamp,
      traceId,
    }, 200);
  } catch (queryErr) {
    console.error('❌ Room lookup failed:', queryErr?.message || queryErr);
    if (queryErr.response?.data) {
      console.error('📄 Astra error response:', JSON.stringify(queryErr.response.data, null, 2));
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to retrieve room.',
      timestamp,
      traceId,
    }, 500);
  }
};
