import { getCollection } from '../../services/astra.js'

/**
 * GET /properties
 * Query params:
 * - page (default 1)
 * - limit (default 12)
 * - q (optional search term for title or location)
 * - sort (optional, e.g. "-createdAt" or "createdAt")
 *
 * Response:
 * {
 *   success: true,
 *   data: { data: [...properties], total, page, limit, sorted: boolean }
 * }
 *
 * Notes:
 * - This handler prefers server-side filtering and sorting where possible.
 * - When the underlying collection driver cannot provide efficient skip/offset,
 *   this implementation will fetch the matching set and slice it for paging.
 *   For large datasets you should replace the slice logic with an indexed
 *   query that supports offset/limit on the DB side.
 */
export const getProperties = async (c) => {
  const timestamp = new Date().toISOString()

  // parse and normalize query params
  const pageRaw = Number(c.req.query('page') || 1)
  const limitRaw = Number(c.req.query('limit') || 12)
  const q = (c.req.query('q') || '').trim()
  const sort = (c.req.query('sort') || '').trim() // e.g. "-createdAt" or "createdAt"

  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? Math.floor(limitRaw) : 12

  // Build a filter object compatible with Astra collection find
  // We support a simple case-insensitive 'contains' search on title or location.
  const hasQuery = Boolean(q)
  let filter = {}
  if (hasQuery) {
    // Many Astra wrappers accept $or with regex; if yours doesn't, replace with appropriate full-text filter
    filter = {
      $or: [
        { title: { $regex: q, $options: 'i' } },
        { location: { $regex: q, $options: 'i' } },
      ],
    }
  }

  let propertiesCol
  try {
    propertiesCol = await getCollection('properties')
  } catch (err) {
    console.error('❌ DB connection error:', err?.message || err)
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
    }, 503)
  }

  try {
    // Try to perform server-side find with optional sort and limit/offset if supported.
    // Many collection APIs accept an options object; adapt this as needed for your driver.
    const sortField = sort ? (sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 }) : null

    // Attempt a server-side call that returns all matches; then we'll slice for paging if driver lacks offset.
    // This keeps behavior consistent across different drivers.
    const findOptions = {}
    if (sortField) findOptions.sort = sortField

    const raw = await propertiesCol.find(filter, findOptions)
    // raw.data shape: object map keyed by document id in Astra wrapper; convert to array
    let list = Array.isArray(raw?.data) ? raw.data : Object.values(raw?.data || {})

    // ensure createdAt exists and coerce to Date for sorting fallback
    list = list.map((item) => ({
      ...item,
      createdAt: item.createdAt || item.created_at || item.createdAtISO || null,
    }))

    // If sort param provided but driver didn't sort (we can't reliably detect), do client-side sort fallback
    if (sort) {
      const desc = sort.startsWith('-')
      const key = desc ? sort.slice(1) : sort
      list.sort((a, b) => {
        const va = a[key] ? new Date(a[key]).getTime() : 0
        const vb = b[key] ? new Date(b[key]).getTime() : 0
        return desc ? vb - va : va - vb
      })
    } else {
      // default: most recent first (createdAt)
      list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    }

    const total = list.length
    const start = (page - 1) * limit
    const end = start + limit
    const pageSlice = list.slice(start, end)

    return c.json({
      success: true,
      data: pageSlice,
      total,
      page,
      limit,
      sorted: Boolean(sort || true), // server returns sorted list (we ensure sorting above)
      timestamp,
    }, 200)
  } catch (err) {
    console.error('❌ getProperties failed:', err?.message || err)
    return c.json({
      success: false,
      error: 'QUERY_FAILED',
      message: 'Failed to fetch properties.',
      timestamp,
    }, 500)
  }
}
