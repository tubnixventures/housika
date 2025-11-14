import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { redis as upstashRedis } from '../../utils/auth.js';

const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 60); // countries change rarely
const INMEM_TTL_MS = Number(process.env.INMEM_COUNTRIES_TTL_MS || 60_000);
const INMEM_MAX = Number(process.env.INMEM_COUNTRIES_MAX || 200);

const inMemCountries = new Map(); // key -> { ts, value }
const cleanupInMem = () => {
  if (inMemCountries.size <= INMEM_MAX) return;
  const keys = Array.from(inMemCountries.keys()).sort((a, b) => inMemCountries.get(a).ts - inMemCountries.get(b).ts);
  for (let i = 0; i < Math.floor(keys.length / 4); i += 1) {
    inMemCountries.delete(keys[i]);
    if (inMemCountries.size <= INMEM_MAX) break;
  }
};
const inMemGet = (k) => {
  const e = inMemCountries.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > INMEM_TTL_MS) {
    inMemCountries.delete(k);
    return null;
  }
  return e.value;
};
const inMemSet = (k, v) => {
  inMemCountries.set(k, { ts: Date.now(), value: v });
  cleanupInMem();
};

const redisGet = async (key) => {
  try {
    const raw = await upstashRedis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Redis get error (countries):', e?.message || e);
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
    console.warn('Redis set error (countries):', e?.message || e);
  }
};

export const getCountries = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID?.() || `trace-${Date.now()}`;
  const start = Date.now();

  const cacheKey = `${CACHE_KEY_PREFIX}:countries:all`;

  // 1) Try Redis cache
  const rCached = await redisGet(cacheKey);
  if (rCached != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.header('Cache-Control', `public, max-age=${CACHE_TTL_SEC}`);
    c.set('cachePayload', rCached);
    return c.json({
      success: true,
      count: Array.isArray(rCached) ? rCached.length : (rCached?.length || 0),
      data: rCached,
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
    c.header('Cache-Control', `public, max-age=${CACHE_TTL_SEC}`);
    c.set('cachePayload', mem);
    return c.json({
      success: true,
      count: Array.isArray(mem) ? mem.length : (mem?.length || 0),
      data: mem,
      cached: true,
      durationMs: Date.now() - start,
      timestamp,
      traceId,
    }, 200);
  }

  // 3) Cache miss -> fetch DB
  let countriesCol;
  try {
    countriesCol = await getCollection('countries');
    if (!countriesCol || typeof countriesCol.find !== 'function') {
      throw new Error('Collection "countries" missing .find() method.');
    }
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ DB connection failed (countries):', err?.message || err);
    }
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Unable to connect to countries collection.',
      timestamp,
      traceId,
    }, 503);
  }

  try {
    const result = await countriesCol.find({});
    const raw = Array.isArray(result?.data) ? result.data : Object.values(result?.data || {});

    // lightweight projection: id, name, iso, phoneCode, flag (if present)
    const countries = raw.map((p) => ({
      id: p.id || p._id || p.country_id || null,
      name: p.name || p.country || null,
      iso2: p.iso2 || p.code || null,
      iso3: p.iso3 || null,
      phoneCode: p.phone_code || p.dial_code || null,
      flag: p.flag || p.flag_url || null,
      region: p.region || null,
    }));

    // cache best-effort
    inMemSet(cacheKey, countries);
    await redisSet(cacheKey, countries, CACHE_TTL_SEC);

    c.set('cachePayload', countries);
    c.header('X-Cache', 'MISS');
    c.header('Cache-Control', `public, max-age=${CACHE_TTL_SEC}`);
    return c.json({
      success: true,
      count: countries.length,
      data: countries,
      cached: false,
      durationMs: Date.now() - start,
      timestamp,
      traceId,
    }, 200);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Country fetch failed:', err?.message || err);
    }
    return c.json({
      success: false,
      error: 'FETCH_ERROR',
      message: 'Unable to retrieve countries at this time.',
      timestamp,
      traceId,
    }, 500);
  }
};
