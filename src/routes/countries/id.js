import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { redis as upstashRedis } from '../../utils/auth.js';

const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || 'cache';
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 60);
const INMEM_TTL_MS = Number(process.env.INMEM_COUNTRY_TTL_MS || 60_000);
const INMEM_MAX = Number(process.env.INMEM_COUNTRY_MAX || 200);

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
    console.warn('Redis get error (country):', e?.message || e);
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
    console.warn('Redis set error (country):', e?.message || e);
  }
};

const projectCountry = (p) => ({
  id: p.id || p._id || p.country_id || null,
  name: p.name || p.country || null,
  iso2: p.iso2 || p.code || null,
  iso3: p.iso3 || null,
  phoneCode: p.phone_code || p.dial_code || null,
  region: p.region || null,
  flag: p.flag || p.flag_url || null,
});

export const getCountryById = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID?.() || `trace-${Date.now()}`;
  const countryId = c.req.param('id');

  if (!countryId || typeof countryId !== 'string') {
    return c.json({
      success: false,
      error: 'INVALID_COUNTRY_ID',
      message: 'Country ID must be a valid string.',
      timestamp,
      traceId,
    }, 400);
  }

  const cacheKey = `${CACHE_KEY_PREFIX}:country:${countryId}`;

  // 1) Try Redis cache
  const rCached = await redisGet(cacheKey);
  if (rCached != null) {
    c.header('X-Cache', 'HIT-REDIS');
    c.set('cachePayload', rCached);
    return c.json({
      success: true,
      country_id: countryId,
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
      country_id: countryId,
      data: mem,
      cached: true,
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
      console.error('❌ DB connection failed (country):', err?.message || err);
    }
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  try {
    // try lookup by primary id fields; adapt query shape for your Astra driver if needed
    const queryCandidates = [
      { _id: countryId },
      { id: { $eq: countryId } },
      { country_id: { $eq: countryId } },
      { iso2: { $eq: countryId } },
    ];

    let countryRaw = null;
    for (const q of queryCandidates) {
      try {
        const res = await countriesCol.find(q);
        const candidate = Array.isArray(res?.data) ? res.data[0] : Object.values(res?.data || {})[0];
        if (candidate) {
          countryRaw = candidate;
          break;
        }
      } catch (e) {
        // continue to next candidate
      }
    }

    if (!countryRaw) {
      return c.json({
        success: false,
        error: 'COUNTRY_NOT_FOUND',
        message: `No country found with ID "${countryId}".`,
        timestamp,
        traceId,
      }, 404);
    }

    const projected = projectCountry(countryRaw);

    // best-effort cache writes
    inMemSet(cacheKey, projected);
    await redisSet(cacheKey, projected, CACHE_TTL_SEC);

    c.set('cachePayload', projected);
    c.header('X-Cache', 'MISS');
    return c.json({
      success: true,
      country_id: countryId,
      data: projected,
      cached: false,
      timestamp,
      traceId,
    }, 200);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Country lookup failed:', err?.message || err);
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to retrieve country.',
      timestamp,
      traceId,
    }, 500);
  }
};
