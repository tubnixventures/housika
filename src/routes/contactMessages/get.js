import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

/**
 * GET /contactMessages
 * Returns paginated contact messages for authorized roles.
 * Only accessible by customer care, admin, or ceo.
 *
 * Query params:
 *  - page (number, default 1)
 *  - per_page (number, default 20, max 100)
 *  - email (string)          => filter by exact email
 *  - from (ISO date string)  => created_at >= from
 *  - to (ISO date string)    => created_at <= to
 *  - replied (true|false|any) => priority ordering + optional filter
 *
 * Response: { success, count, data, pagination, timestamp, traceId, actor_id }
 */
export const getContactMessages = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  const [actorResult, collectionResult] = await Promise.allSettled([
    token ? checkToken(token) : null,
    getCollection('contact_messages'),
  ]);

  const actor = actorResult.status === 'fulfilled' ? actorResult.value : null;
  const contactMessages = collectionResult.status === 'fulfilled' ? collectionResult.value : null;

  if (!actor || !['customer care', 'admin', 'ceo'].includes(actor.role)) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only customer care, admin, or ceo can view contact messages.',
      timestamp,
      traceId,
    }, 403);
  }

  if (!contactMessages) {
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

  // Pagination params
  const rawPage = c.req.query('page') || '1';
  const rawPerPage = c.req.query('per_page') || '20';
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(rawPerPage, 10) || 20));

  // Filters
  const emailFilter = c.req.query('email');
  const fromDate = c.req.query('from');
  const toDate = c.req.query('to');
  const repliedQ = c.req.query('replied'); // expected 'true' | 'false' | 'any' (or undefined)

  // Build DB query object (best-effort, kept compatible with existing find usage)
  const query = {};
  if (emailFilter) query.email = { $eq: emailFilter };
  if (fromDate || toDate) {
    query.created_at = {};
    if (fromDate) query.created_at.$gte = fromDate;
    if (toDate) query.created_at.$lte = toDate;
  }
  if (repliedQ === 'true') {
    query.replied = { $eq: true };
  } else if (repliedQ === 'false') {
    query.replied = { $eq: false };
  }
  // Note: if repliedQ is 'any' or undefined, we do not add replied filter;
  // later we will prioritise unreplied messages first in sorting.

  let messages = [];
  try {
    const result = await contactMessages.find(query);
    messages = Object.values(result?.data || {});
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Query failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'QUERY_FAILED',
      message: 'Failed to retrieve contact messages.',
      timestamp,
      traceId,
    }, 500);
  }

  // Normalise created_at to Date for sorting safety (don't mutate original objects)
  const withDates = messages.map((m) => ({
    ...m,
    __created_at_date: m.created_at ? new Date(m.created_at) : new Date(0),
    __replied_bool: !!m.replied,
  }));

  // Sort:
  // 1) unreplied messages first (replied: false before true)
  // 2) then by created_at desc (newest first)
  withDates.sort((a, b) => {
    if (a.__replied_bool !== b.__replied_bool) {
      return a.__replied_bool ? 1 : -1; // unreplied (false) come first
    }
    return b.__created_at_date - a.__created_at_date;
  });

  // Pagination calculations
  const total = withDates.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * perPage;
  const end = start + perPage;
  const pageItems = withDates.slice(start, end).map((m) => {
    // remove internal helpers before returning
    const { __created_at_date, __replied_bool, ...rest } = m;
    return rest;
  });

  // Build pages array for frontend (prev, numbered pages, next)
  // We will show up to 5 page buttons centered around current when possible
  const maxButtons = 5;
  let startPage = 1;
  let endPage = Math.min(totalPages, maxButtons);

  if (totalPages > maxButtons) {
    const half = Math.floor(maxButtons / 2);
    startPage = Math.max(1, currentPage - half);
    endPage = startPage + maxButtons - 1;
    if (endPage > totalPages) {
      endPage = totalPages;
      startPage = totalPages - maxButtons + 1;
    }
  }

  const pages = [];
  for (let p = startPage; p <= endPage; p += 1) {
    pages.push({
      page: p,
      is_current: p === currentPage,
    });
  }

  const pagination = {
    total,
    per_page: perPage,
    current_page: currentPage,
    total_pages: totalPages,
    prev_page: currentPage > 1 ? currentPage - 1 : null,
    next_page: currentPage < totalPages ? currentPage + 1 : null,
    pages,
  };

  return c.json({
    success: true,
    count: pageItems.length,
    data: pageItems,
    pagination,
    timestamp,
    traceId,
    actor_id: actor.userId,
  }, 200);
};
