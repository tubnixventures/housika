import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

const HIERARCHY = ['real estate company', 'landlord', 'dual', 'customer care', 'admin', 'ceo'];

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export const getUsers = async (c) => {
  const start = Date.now();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const token = c.req.header('Authorization')?.replace('Bearer ', '') || '';
  const timestamp = new Date().toISOString();

  // Auth guard
  if (!token) {
    return c.json({
      success: false,
      error: 'MISSING_TOKEN',
      message: 'Missing authentication token.',
      timestamp,
      traceId,
    }, 401);
  }

  const actor = await checkToken(token).catch((err) => {
    console.error('❌ Token check failed:', err?.message || err);
    return null;
  });

  if (!actor?.role) {
    return c.json({
      success: false,
      error: 'INVALID_TOKEN',
      message: 'Invalid or expired token.',
      timestamp,
      traceId,
    }, 401);
  }

  const actorRank = HIERARCHY.indexOf(actor.role);
  if (actorRank === -1) {
    return c.json({
      success: false,
      error: 'ROLE_UNKNOWN',
      message: 'Your role is not recognized in the hierarchy.',
      timestamp,
      traceId,
    }, 400);
  }

  // Pagination params
  const q = Object.fromEntries(c.req.query()); // hono Request query helper
  const page = parsePositiveInt(q.page, 1);
  const pageSizeRaw = parsePositiveInt(q.pageSize, 10);
  const pageSize = Math.min(Math.max(pageSizeRaw, 1), 100); // enforce 1..100

  // optional filters: allow filtering by email, phonenumber, role, or search
  const filters = {};
  if (q.email) filters.email = q.email;
  if (q.phonenumber) filters.phonenumber = q.phonenumber;
  if (q.role) filters.role = q.role;
  if (q.search) filters.search = String(q.search).trim();

  // Determine visible roles for this actor
  const visibleRoles = actor.role === 'ceo'
    ? HIERARCHY
    : HIERARCHY.slice(0, actorRank + 1);

  // Build a query that restricts role to visibleRoles and applies any simple filters
  const baseQuery = { role: { $in: visibleRoles } };

  if (filters.email) {
    baseQuery.email = { $eq: filters.email };
  }
  if (filters.phonenumber) {
    baseQuery.phonenumber = { $eq: filters.phonenumber };
  }
  if (filters.role) {
    // ensure requested role is within visibleRoles
    if (!visibleRoles.includes(filters.role)) {
      return c.json({
        success: false,
        error: 'FORBIDDEN_ROLE_FILTER',
        message: 'You cannot filter for roles outside your visibility.',
        timestamp,
        traceId,
      }, 403);
    }
    baseQuery.role = { $eq: filters.role };
  }

  let usersCollection;
  try {
    usersCollection = await getCollection('users');
  } catch (err) {
    console.error('❌ DB connection error:', err.message || err);
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  // Attempt to use collection-level pagination if supported (best-effort)
  try {
    // Preferred: collection.find with pagination / sorting options
    // Many Astra SDKs support options like { page, pageSize, sort: { created_at: -1 } }
    // If your SDK supports cursor-based paging, replace this block with native cursor usage.
    if (typeof usersCollection.find === 'function') {
      // Try call with pagination options; SDK may ignore unknown options (safe)
      const findOptions = {
        page,
        pageSize,
        sort: { created_at: -1 }, // latest first
      };

      // If a `search` filter was provided, attempt naive text match after retrieving
      const findQuery = baseQuery;

      const result = await usersCollection.find(findQuery, findOptions);
      // If SDK returned a shaped result with count and page metadata, use it directly
      if (result && typeof result === 'object' && Array.isArray(result.data) === false) {
        // Some SDKs return object keyed by docId; convert to array
        const usersArray = Object.values(result.data || {});
        // perform sort and slice fallback if SDK didn't honor page options
        usersArray.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        const total = usersArray.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const safePage = Math.min(Math.max(page, 1), totalPages);
        const startIndex = (safePage - 1) * pageSize;
        const pageSlice = usersArray.slice(startIndex, startIndex + pageSize);

        return c.json({
          success: true,
          count: pageSlice.length,
          page: safePage,
          pageSize,
          total,
          totalPages,
          hasNext: safePage < totalPages,
          hasPrev: safePage > 1,
          visibleRoles,
          data: pageSlice,
          timestamp,
          traceId,
          duration: `${Date.now() - start}ms`,
        });
      }

      // If SDK returned a response shaped as { data: [...] } use it directly
      if (result && result.data && Array.isArray(result.data)) {
        const users = result.data;
        const total = typeof result.total === 'number' ? result.total : users.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        return c.json({
          success: true,
          count: users.length,
          page,
          pageSize,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
          visibleRoles,
          data: users,
          timestamp,
          traceId,
          duration: `${Date.now() - start}ms`,
        });
      }

      // If result is unexpected, fall through to manual fetch below
    }
  } catch (err) {
    console.warn('⚠️ Collection-level pagination attempt failed, falling back to manual paging:', err?.message || err);
    // continue to manual pagination fallback
  }

  // Manual fallback: fetch all matching docs (restricted by visibleRoles) and slice server-side
  try {
    const lookupResult = await usersCollection.find(baseQuery);
    const allUsers = Object.values(lookupResult?.data || {});

    // Optional simple search client-side (case-insensitive) if search query provided
    let filtered = allUsers;
    if (filters.search) {
      const s = filters.search.toLowerCase();
      filtered = filtered.filter(u =>
        (u.fullname || '').toLowerCase().includes(s) ||
        (u.email || '').toLowerCase().includes(s) ||
        (u.phonenumber || '').toLowerCase().includes(s)
      );
    }

    // sort latest-first by created_at (ISO string) or fallback to insertion order
    filtered.sort((a, b) => {
      const ta = a.created_at || '';
      const tb = b.created_at || '';
      return tb.localeCompare(ta);
    });

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(page, 1), totalPages);
    const startIndex = (safePage - 1) * pageSize;
    const pageSlice = filtered.slice(startIndex, startIndex + pageSize);

    return c.json({
      success: true,
      count: pageSlice.length,
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
      visibleRoles,
      data: pageSlice,
      timestamp,
      traceId,
      duration: `${Date.now() - start}ms`,
    });
  } catch (err) {
    console.error('❌ User query failed:', err.message || err);
    if (err.response?.data) {
      console.error('📄 Astra error response:', JSON.stringify(err.response.data, null, 2));
    }

    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to fetch users.',
      timestamp,
      traceId,
    }, 500);
  }
};
