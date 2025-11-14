import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { redis as upstashRedis } from '../../utils/auth.js';

const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 15); // short TTL for dynamic searches
const INMEM_TTL_MS = Number(process.env.INMEM_FIND_TTL_MS || 3000);
const INMEM_MAX = Number(process.env.INMEM_FIND_MAX || 300);
const MAX_RESULTS = Number(process.env.MAX_FIND_RESULTS || 200); // clamp to avoid huge responses

// in-memory fallback cache: key -> { ts, value }
const inMemFind = new Map();
const cleanupInMem = () => {
  if (inMemFind.size <= INMEM_MAX) return;
  const keys = Array.from(inMemFind.keys()).sort((a, b) => inMemFind.get(a).ts - inMemFind.get(b).ts);
  for (let i = 0; i < Math.floor(keys.length / 4); i += 1) {
    inMemFind.delete(keys[i]);
    if (inMemFind.size <= INMEM_MAX) break;
  }
};
const inMemGet = (k) => {
  const e = inMemFind.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > INMEM_TTL_MS) {
    inMemFind.delete(k);
    return null;
  }
  return e.value;
};
const inMemSet = (k, v) => {
  inMemFind.set(k, { ts: Date.now(), value: v });
  cleanupInMem();
};

const redisGet = async (key) => {
  try {
    const raw = await upstashRedis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Redis get error (find):', e?.message || e);
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
    console.warn('Redis set error (find):', e?.message || e);
  }
};

const safeString = (v) => (typeof v === 'string' ? v.trim() : '');
const safeNumber = (v) => (v == null ? null : Number(v));

const makeCacheKey = (filters) => {
  // deterministic key: sorted JSON
  const stable = JSON.stringify(Object.keys(filters).sort().reduce((acc, k) => {
    acc[k] = filters[k];
    return acc;
  }, {}));
  return `${CACHE_KEY_PREFIX}:find:${Buffer.from(stable).toString('base64')}`;
};

const projectEntity = (e) => ({
  id: e.id || e._id || e.property_id || e.room_id || null,
  title: e.title || e.name || null,
  price: e.price || e.amount || null,
  currency: e.currency || e.price_currency || null,
  location: e.location || e.address || null,
  thumbnail: Array.isArray(e.photos) ? e.photos[0] : e.thumbnail || null,
  createdAt: e.createdAt || e.created_at || null,
  propertyId: e.property_id || e.propertyId || null,
  shortDescription: e.shortDescription || e.description || null,
});

const clampArray = (arr) => (Array.isArray(arr) && arr.length > MAX_RESULTS ? arr.slice(0, MAX_RESULTS) : arr);

const buildQueryFromFilters = (filters) => {
  const propertyQuery = {};
  const roomQuery = {};

  if (filters.location) propertyQuery.location = { $eq: safeString(filters.location) };
  if (filters.exact_location) propertyQuery.exact_location = { $eq: safeString(filters.exact_location) };
  if (filters.description) propertyQuery.description = { $contains: safeString(filters.description) };
  if (filters.country) propertyQuery.country = { $eq: safeString(filters.country) };
  if (filters.latitude) propertyQuery.latitude = { $eq: safeNumber(filters.latitude) };
  if (filters.longitude) propertyQuery.longitude = { $eq: safeNumber(filters.longitude) };
  if (filters.property_name) propertyQuery.title = { $contains: safeString(filters.property_name) };

  if (filters.currency) roomQuery.currency = { $eq: safeString(filters.currency) };
  if (filters.amount) roomQuery.amount = { $lte: safeNumber(filters.amount) };
  if (filters.period) roomQuery.period = { $eq: safeString(filters.period) };
  if (filters.category) roomQuery.category = { $eq: safeString(filters.category) };

  // text search: if q provided, use regex on indexed fields as a fallback
  if (filters.q) {
    const q = safeString(filters.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const orClause = [
      { title: { $regex: q, $options: 'i' } },
      { location: { $regex: q, $options: 'i' } },
      { description: { $regex: q, $options: 'i' } },
    ];
    propertyQuery.$or = orClause;
    roomQuery.$or = orClause;
  }

  return { propertyQuery, roomQuery };
};

const defaultProjection = {
  // if your driver supports projection object, adapt accordingly
  // Here projection is logical; actual driver usage handled in find calls if it supports options
  // We still map to projectEntity afterward
};

const DEFAULT_SORT = { createdAt: -1 };

const safeFindWithOptions = async (col, query, options = {}) => {
  // Attempt server-side paged find if supported; fall back to simple find
  try {
    return await col.find(query, options);
  } catch (e) {
    // fallback to unpaged find
    return await col.find(query);
  }
};

// Handler
const find = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID?.() || `trace-${Date.now()}`;

  let filters;
  try {
    filters = await c.req.json();
    if (!filters || typeof filters !== 'object') throw new Error('Invalid JSON');
  } catch (err) {
    return c.json({
      success: false,
      error: 'INVALID_FILTERS',
      message: 'Request body must be valid JSON.',
      timestamp,
      traceId,
    }, 400);
  }

  // normalize pagination (optional)
  const rawPage = Number(filters.page || 1);
  const rawLimit = Number(filters.limit || 50);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.max(1, Math.floor(rawPage)) : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 50;
  const offset = (page - 1) * limit;

  const cacheKey = makeCacheKey({ ...filters, page, limit });

  // 1) Try Redis cache
  const rCached = await redisGet(cacheKey);
  if (rCached != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.set('cachePayload', rCached);
    return c.json({ success: true, ...rCached, cached: true, traceId, timestamp }, 200);
  }

  // 2) Try in-memory fallback
  const mem = inMemGet(cacheKey);
  if (mem != null) {
    c.header('X-Cache', 'HIT-MEM');
    c.set('cachePayload', mem);
    return c.json({ success: true, ...mem, cached: true, traceId, timestamp }, 200);
  }

  // Resolve collections in parallel
  const [propertiesResult, roomsResult] = await Promise.allSettled([
    getCollection('properties'),
    getCollection('rooms'),
  ]);

  const propertiesCol = propertiesResult.status === 'fulfilled' ? propertiesResult.value : null;
  const roomsCol = roomsResult.status === 'fulfilled' ? roomsResult.value : null;

  if (!propertiesCol || !roomsCol) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ DB connection failed:', propertiesResult.reason || roomsResult.reason);
    }
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  const { propertyQuery, roomQuery } = buildQueryFromFilters(filters);

  try {
    // Use server-side options if supported (limit/offset/sort)
    const propOptions = { limit: limit, offset, sort: DEFAULT_SORT };
    const roomOptions = { limit: limit, offset, sort: DEFAULT_SORT };

    const [propertyRaw, roomRaw] = await Promise.all([
      safeFindWithOptions(propertiesCol, propertyQuery, propOptions),
      safeFindWithOptions(roomsCol, roomQuery, roomOptions),
    ]);

    let props = Array.isArray(propertyRaw?.data) ? propertyRaw.data : Object.values(propertyRaw?.data || {});
    let rooms = Array.isArray(roomRaw?.data) ? roomRaw.data : Object.values(roomRaw?.data || {});

    // If driver returned unpaged data when we asked for paging, slice here
    if (!Array.isArray(propertyRaw?.data) && props.length > offset) props = props.slice(offset, offset + limit);
    if (!Array.isArray(roomRaw?.data) && rooms.length > offset) rooms = rooms.slice(offset, offset + limit);

    // Map to compact shapes
    const mappedProperties = clampArray(props.map(projectEntity));
    const mappedRooms = clampArray(rooms.map(projectEntity));

    // Optionally link rooms to their property by propertyId
    const linkByPropertyId = filters.linked === true;
    const enrichedRooms = linkByPropertyId
      ? mappedRooms.map((room) => ({ ...room, property: mappedProperties.find((p) => p.id === room.propertyId) || null }))
      : mappedRooms;

    const payload = {
      filters,
      matched: { properties: mappedProperties.length, rooms: mappedRooms.length },
      data: { properties: mappedProperties, rooms: enrichedRooms },
      page,
      limit,
    };

    // Best-effort caching
    inMemSet(cacheKey, payload);
    await redisSet(cacheKey, payload, CACHE_TTL_SEC);

    c.set('cachePayload', payload);
    c.header('X-Cache', 'MISS');
    return c.json({ success: true, ...payload, timestamp, traceId }, 200);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Query execution failed:', err?.message || err);
    }
    return c.json({
      success: false,
      error: 'QUERY_FAILED',
      message: 'Failed to execute search queries.',
      timestamp,
      traceId,
    }, 500);
  }
};

export default find;
