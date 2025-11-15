import crypto from 'crypto'
import { getCollection } from '../../services/astra.js'
import { checkToken } from '../../utils/auth.js'

/*
  Admin stats endpoint
  - returns simple counts for dashboard cards (properties, countries, messages, users, receipts)
  - does NOT fetch payments (confidential) — payments: null
  - respects auth (requires token) and returns a traceId for observability
  - robust against different Astra SDK shapes (count method, find returning keyed object, find returning array)
*/

function safeParseInt(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback
}

async function collectionCount(col, traceId) {
  // Try to use the SDK's fast count if available, otherwise fall back to fetching minimal data and counting
  if (!col) return 0

  // Common SDKs may expose a countDocuments/count method
  if (typeof col.count === 'function') {
    try {
      const c = await col.count()
      return safeParseInt(c, 0)
    } catch {
      // continue to fallback
    }
  }
  if (typeof col.countDocuments === 'function') {
    try {
      const c = await col.countDocuments()
      return safeParseInt(c, 0)
    } catch {
      // continue to fallback
    }
  }

  // Try collection.find with options that limit transfer (SDK-specific)
  if (typeof col.find === 'function') {
    try {
      // Preferred: ask SDK for small result with only keys
      // Some SDKs accept { page: 1, pageSize: 1, count: true } — try best-effort patterns
      const tryCountPatterns = [
        () => col.find({}, { page: 1, pageSize: 1 }),
        () => col.find({}, { limit: 1 }),
        () => col.find({}, { fields: ['_id'] }),
        () => col.find({}),
      ]
      for (const fn of tryCountPatterns) {
        try {
          const r = await fn()
          if (!r) continue
          // If SDK returns { total } or { count } use it
          if (typeof r === 'object' && ('total' in r || 'count' in r)) {
            const v = r.total ?? r.count
            return safeParseInt(v, 0)
          }
          // If r.data is array-like
          if (r && Array.isArray(r.data)) {
            // Some SDKs return page of docs; length isn't total — skip unless result.total exists
            if (typeof r.total === 'number') return safeParseInt(r.total, 0)
            // fallback: convert to array and count keys if keyed object
            return Array.isArray(r.data) ? r.data.length : 0
          }
          // If result is an object keyed by id, count values
          if (typeof r === 'object' && !Array.isArray(r)) {
            const vals = Object.values(r)
            return Array.isArray(vals) ? vals.length : 0
          }
          // If result is an array directly
          if (Array.isArray(r)) return r.length
        } catch {
          // try next pattern
        }
      }
    } catch {
      // proceed to final fallback
    }
  }

  // Final fallback: attempt to fetch all keys and count
  try {
    const r = await col.find?.({}, { page: 1, pageSize: 100000 }) || await col.find?.({}) || {}
    if (Array.isArray(r)) return r.length
    if (r && Array.isArray(r.data)) return r.data.length
    if (r && typeof r === 'object') return Object.values(r).length
  } catch (err) {
    // give up and return 0
    // caller will log
  }

  return 0
}

export const getAdminStats = async (c) => {
  const start = Date.now()
  const incomingTrace = c.req.header('x-trace-id') || c.req.query?.()?.traceId
  const traceId = (incomingTrace && String(incomingTrace)) || crypto.randomUUID()
  const timestamp = new Date().toISOString()

  // minimal CORS/observability header (your main middleware should set CORS correctly)
  try { c.header('X-Trace-Id', traceId) } catch {}

  // Auth
  const authHeader = c.req.header('Authorization') || ''
  const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : ''
  if (!token) {
    return c.json({
      success: false,
      error: 'MISSING_TOKEN',
      message: 'Missing authentication token.',
      traceId,
      timestamp,
      duration: `${Date.now() - start}ms`,
    }, 401)
  }

  let actor = null
  try {
    actor = await checkToken(token)
  } catch (err) {
    console.error(`[${traceId}] Token validation failed:`, err?.message || err)
    return c.json({
      success: false,
      error: 'INVALID_TOKEN',
      message: 'Invalid or expired token.',
      traceId,
      timestamp,
      duration: `${Date.now() - start}ms`,
    }, 401)
  }

  if (!actor?.role) {
    return c.json({
      success: false,
      error: 'INVALID_TOKEN',
      message: 'Invalid or expired token.',
      traceId,
      timestamp,
      duration: `${Date.now() - start}ms`,
    }, 401)
  }

  // Only allow known roles (defensive)
  const HIERARCHY = ['real estate company', 'landlord', 'dual', 'customer care', 'admin', 'ceo']
  const actorRank = HIERARCHY.indexOf(actor.role)
  if (actorRank === -1) {
    return c.json({
      success: false,
      error: 'ROLE_UNKNOWN',
      message: 'Your role is not recognized.',
      traceId,
      timestamp,
      duration: `${Date.now() - start}ms`,
    }, 403)
  }

  // Determine which collections we will query for counts.
  // Dashboard requires: properties, countries, contact-messages (messages), users, receipts.
  // Payments are confidential and intentionally not fetched.
  const collectionsToFetch = {
    properties: 'properties',
    countries: 'countries',
    messages: 'contact-messages',
    users: 'users',
    receipts: 'receipts',
  }

  // Connect to collections in parallel and compute counts
  try {
    const colPromises = Object.entries(collectionsToFetch).map(async ([key, colName]) => {
      try {
        const col = await getCollection(colName)
        const count = await collectionCount(col, traceId)
        return [key, count]
      } catch (err) {
        console.error(`[${traceId}] Failed to get count for ${colName}:`, err?.message || err)
        return [key, 0]
      }
    })

    const entries = await Promise.all(colPromises)
    const counts = Object.fromEntries(entries)

    // Respect executive safety: backend should already redact sensitive fields.
    // For the dashboard we only expose counts; payments intentionally omitted.
    const payload = {
      properties: counts.properties ?? 0,
      countries: counts.countries ?? 0,
      messages: counts.messages ?? 0,
      users: counts.users ?? 0,
      receipts: counts.receipts ?? 0,
      payments: null, // confidential
    }

    return c.json({
      success: true,
      data: payload,
      timestamp,
      traceId,
      duration: `${Date.now() - start}ms`,
    })
  } catch (err) {
    console.error(`[${traceId}] Admin stats collection error:`, err?.message || err)
    return c.json({
      success: false,
      error: 'STATS_FETCH_FAILED',
      message: 'Failed to compute stats.',
      traceId,
      timestamp,
      duration: `${Date.now() - start}ms`,
    }, 500)
  }
}
