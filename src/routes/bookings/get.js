// get.js
import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

const parsePositiveInt = (v, fallback) => {
  const n = Number(v);
  if (Number.isInteger(n) && n > 0) return n;
  return fallback;
};

const bookings = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Missing token.',
      timestamp,
      traceId,
    }, 401);
  }

  // resolve token and collection in parallel
  const [userResult, collectionResult] = await Promise.allSettled([
    checkToken(token),
    getCollection('bookings'),
  ]);

  const user = userResult.status === 'fulfilled' ? userResult.value : null;
  const bookingsCol = collectionResult.status === 'fulfilled' ? collectionResult.value : null;

  if (!user?.userId) {
    return c.json({
      success: false,
      error: 'INVALID_TOKEN',
      message: 'Invalid or expired token.',
      timestamp,
      traceId,
    }, 401);
  }

  if (!bookingsCol) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ DB connection failed:', collectionResult.reason?.message || collectionResult.reason);
    }
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  // Query params for pagination
  const url = new URL(c.req.url);
  const page = parsePositiveInt(url.searchParams.get('page'), 1);
  const perPage = parsePositiveInt(url.searchParams.get('per_page'), 20);

  // Determine whether actor can access all bookings
  const privilegedRoles = ['admin', 'ceo', 'customercare'];
  const isPrivileged = privilegedRoles.includes(String(user.role || user?.role || '').toLowerCase());

  try {
    // Fetch all relevant records from DB
    // Note: If your DB client supports server-side pagination and sort, replace this with a query using limit/skip/sort.
    let result;
    if (isPrivileged) {
      // fetch all bookings
      result = await bookingsCol.find({});
    } else {
      // fetch only bookings for this tenant
      result = await bookingsCol.find({ tenant_id: { $eq: user.userId } });
    }

    const all = Object.values(result?.data || {});

    // Sort latest-first by created_at if present; otherwise keep insertion order
    all.sort((a, b) => {
      const ta = a?.created_at ? Date.parse(a.created_at) : 0;
      const tb = b?.created_at ? Date.parse(b.created_at) : 0;
      return tb - ta;
    });

    // In-memory pagination
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * perPage;
    const endIndex = startIndex + perPage;
    const pageData = all.slice(startIndex, endIndex);

    return c.json({
      success: true,
      userId: user.userId,
      role: user.role || user?.role || '',
      count: total,
      page: currentPage,
      per_page: perPage,
      total_pages: totalPages,
      has_prev: currentPage > 1,
      has_next: currentPage < totalPages,
      prev_page: currentPage > 1 ? currentPage - 1 : null,
      next_page: currentPage < totalPages ? currentPage + 1 : null,
      data: pageData,
      timestamp,
      traceId,
    }, 200);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Booking query failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to fetch bookings.',
      timestamp,
      traceId,
    }, 500);
  }
};

export default bookings;
