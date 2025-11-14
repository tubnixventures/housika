// src/routes/properties/getProperties.js
import { getCollection } from '../../services/astra.js';

/**
 * GET /properties
 * Improved: server-side pagination + projection + optional  short-term in-memory cache
 *
 * Query params:
 *  - page (default 1)
 *  - limit (default 12, max 100)
 *  - q (optional search term applying to title or location)
 *  - sort (optional, e.g. "-createdAt" or "createdAt")
 *
 * Response:
 *  { success: true, data: [...], total, page, limit, timestamp }
 */

// In-process short-lived cache for identical queries (TTL in ms).
// Useful for hot endpoints behind a load-balanced single-process instance or during quick retries.
// Keep small and short TTL to avoid stale data; remove if you have a shared cache like Redis.
const CACHE_TTL = 5000; // 5 seconds
const CACHE_MAX = 200;
const queryCache = new Map(); // key -> { ts, value }

const makeCacheKey = (obj) => JSON.stringify(obj);

const cleanupCache = () => {
  if (queryCache.size <= CACHE_MAX) return;
  const keys = Array.from(queryCache.keys());
  // remove oldest entries
  for (let i = 0; i < Math.floor(keys.length / 4); i += 1) {
    queryCache.delete(keys[i]);
    if (queryCache.size <= CACHE_MAX) break;
  }
};

export const getProperties = async (c) => {
  const started = Date.now();
  const timestamp = new Date().toISOString();

  // Parse and validate query params
  const rawPage = Number(c.req.query('page') || 1);
  const rawLimit = Number(c.req.query('limit') || 12);
  const q = (c.req.query('q') || '').trim();
  const sort = (c.req.query('sort') || '').trim(); // "-createdAt" or "createdAt"

  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), 100)
    : 12;

  // Build filter: prefer server-side full-text or regex on indexed fields
  const filter = {};
  if (q) {
    // Prefer a text-search-capable backend. If Astra supports $text use it; otherwise fallback to case-insensitive regex.
    // Try $text first (uncomment if supported), otherwise use regex.
    // filter.$text = { $search: q };

    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex chars
    filter.$or = [
      { title: { $regex: safeQ, $options: 'i' } },
      { location: { $regex: safeQ, $options: 'i' } },
    ];
  }

  // Projection: return only necessary fields (keeps payload small)
  const projection = {
    receipt_id: 0, // irrelevant for properties, example of excluding fields; adapt to your schema
    // include: id, title, price, location, photos[0], createdAt, slug, short description
    // For Astra wrapper, projection may be { fields: ['id','title', ...] } - adapt if required
  };

  // Compute sort object: prefer server-side sort on createdAt
  let sortObj = { createdAt: -1 }; // default: newest first
  if (sort) {
    const desc = sort.startsWith('-');
    const key = desc ? sort.slice(1) : sort;
    sortObj = { [key]: desc ? -1 : 1 };
  }

  // Query key for short-term cache
  const cacheKey = makeCacheKey({ page, limit, q, sort });
  const now = Date.now();
  const cached = queryCache.get(cacheKey);
  if (cached && now - cached.ts < CACHE_TTL) {
    // Return cached copy (fast-path)
    return c.json({
      success: true,
      data: cached.value.data,
      total: cached.value.total,
      page,
      limit,
      cached: true,
      durationMs: Date.now() - started,
      timestamp,
    }, 200);
  }

  // Connect to collection
  let propertiesCol;
  try {
    propertiesCol = await getCollection('properties');
  } catch (err) {
    console.error('❌ DB connection error:', err?.message || err);
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
    }, 503);
  }

  try {
    // Attempt server-side paginated query using limit + offset/skip if the driver supports it.
    // Many Astra wrappers accept options: { limit, offset, sort, projection }
    const options = {
      limit,
      offset: (page - 1) * limit,
      sort: sortObj,
      projection: projection, // adapt key depending on your driver
    };

    // Primary attempt: server-side paged find
    const raw = await propertiesCol.find(filter, options);

    // raw.data shape: array or object map depending on wrapper; normalize to array
    let rows = Array.isArray(raw?.data) ? raw.data : Object.values(raw?.data || {});

    // If driver returns partial documents, map to sanitized shape and lightweight fields
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

    // Attempt to get total count: some drivers return total in raw.total or raw.count
    const total = typeof raw?.total === 'number' ? raw.total
      : typeof raw?.count === 'number' ? raw.count
      : // Fallback: if driver didn't provide count, do a cheap count query if supported
      null;

    // If total is null and driver doesn't support count, try a separate count call (may be slower)
    let finalTotal = total;
    if (finalTotal === null && typeof propertiesCol.count === 'function') {
      try {
        finalTotal = await propertiesCol.count(filter);
      } catch (countErr) {
        // If counting is expensive/unavailable, set to data.length + offset as approximate
        finalTotal = (page - 1) * limit + data.length;
      }
    } else if (finalTotal === null) {
      finalTotal = (page - 1) * limit + data.length;
    }

    // Cache the result (short TTL)
    queryCache.set(cacheKey, { ts: now, value: { data, total: finalTotal } });
    cleanupCache();

    return c.json({
      success: true,
      data,
      total: finalTotal,
      page,
      limit,
      cached: false,
      durationMs: Date.now() - started,
      timestamp,
    }, 200);
  } catch (err) {
    // Fallback: if server-side paging not supported, do efficient limited fetch then slice
    console.warn('Primary paged query failed, falling back to safe fetch:', err?.message || err);
    try {
      const rawAll = await propertiesCol.find(filter);
      let all = Array.isArray(rawAll?.data) ? rawAll.data : Object.values(rawAll?.data || {});
      // lightweight mapping
      all = all.map((item) => ({
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

      // client-side sort fallback
      if (sort) {
        const desc = sort.startsWith('-');
        const key = desc ? sort.slice(1) : sort;
        all.sort((a, b) => {
          const va = a[key] ? new Date(a[key]).getTime() : 0;
          const vb = b[key] ? new Date(b[key]).getTime() : 0;
          return desc ? vb - va : va - vb;
        });
      } else {
        all.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      }

      const total = all.length;
      const start = (page - 1) * limit;
      const pageSlice = all.slice(start, start + limit);

      // Cache fallback result briefly
      queryCache.set(cacheKey, { ts: now, value: { data: pageSlice, total } });
      cleanupCache();

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
      console.error('❌ getProperties final fallback failed:', finalErr?.message || finalErr);
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
