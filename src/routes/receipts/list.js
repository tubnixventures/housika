// src/routes/receipts/list.js
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

/**
 * GET /receipts/mine
 * Query params:
 *  - page (default 1)
 *  - page_size (default 20, max 100)
 *  - q (optional search across tenant_name or property_name)
 *  - from, to (ISO dates for created_at range)
 *  - currency (ISO 4217 filter)
 *
 * Returns paginated receipts created by the authenticated user with normalized
 * currency fields (amount_value, amount_currency, amount_display).
 */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const ALLOWED_ROLES = new Set(['landlord', 'dual']);

const list = async (c) => {
  const timestamp = new Date().toISOString();

  // Auth
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const user = token ? await checkToken(token) : null;
  if (!user || !ALLOWED_ROLES.has(user.role)) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only landlords or dual-role users can view their receipts.',
      timestamp,
    }, 403);
  }

  // Parse and validate query params
  const rawPage = Number(c.req.query('page') || DEFAULT_PAGE);
  const rawPageSize = Number(c.req.query('page_size') || DEFAULT_PAGE_SIZE);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : DEFAULT_PAGE;
  const page_size = Number.isInteger(rawPageSize) && rawPageSize > 0
    ? Math.min(rawPageSize, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  const q = (c.req.query('q') || '').trim() || null;
  const currency = (c.req.query('currency') || '').trim().toUpperCase() || null;
  const from = (c.req.query('from') || '').trim() || null; // ISO date string
  const to = (c.req.query('to') || '').trim() || null;     // ISO date string

  // Build Astra query filter (adapter for your DB client)
  // Note: Astra wrapper used in project supports simple equality filters passed to find()
  // For more complex queries, adjust to your DB SDK (Astra REST, CQL, or other).
  const filters = { created_by: user.userId };

  // Apply currency filter if provided
  if (currency) filters.amount_currency = currency;

  // Time-range filter expressed as created_at range; if Astra wrapper doesn't support range,
  // you may need to fetch and filter in-app or switch to a DB-level query.
  // For safety we add them as special keys for your DB wrapper to interpret.
  if (from) filters.created_at_from = from;
  if (to) filters.created_at_to = to;

  // Paging: compute offset-like semantics (Astra find may not support offset; prefer indexed queries)
  const offset = (page - 1) * page_size;

  let receiptsCol;
  try {
    receiptsCol = await getCollection('receipts');
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
    // Attempt to use collection-level search with filters and pagination.
    // Adjust to your actual `find` API: this example assumes find(filter, { limit, offset, sort })
    const findOptions = {
      limit: page_size,
      offset,
      sort: { created_at: 'desc' },
      // Use q for server-side search if supported; otherwise fallback to client-side filter below
      ...(q ? { q } : {}),
    };

    const result = await receiptsCol.find(filters, findOptions);
    // result.data expected to be an object map from id->record for Astra wrapper in this codebase
    const items = Object.values(result?.data || {});

    // If the DB wrapper doesn't support range or q properly, apply safe in-memory filtering
    const filtered = items.filter((r) => {
      if (q) {
        const term = q.toLowerCase();
        if (!(
          String(r.tenant_name || '').toLowerCase().includes(term) ||
          String(r.property_name || '').toLowerCase().includes(term)
        )) return false;
      }
      if (from && r.created_at && r.created_at < from) return false;
      if (to && r.created_at && r.created_at > to) return false;
      if (currency && r.amount_currency && r.amount_currency !== currency) return false;
      return true;
    });

    // If the underlying DB supports counting, replace totalCount with DB-provided value
    const totalCount = Number(result?.total || filtered.length);

    // Sanitize output: only expose necessary fields to the caller
    const sanitized = filtered.map((r) => ({
      receipt_id: r.receipt_id,
      receipt_number: r.receipt_number || null,
      tenant_name: r.tenant_name || null,
      property_name: r.property_name || null,
      amount_value: typeof r.amount_value !== 'undefined' ? r.amount_value : null,
      amount_currency: r.amount_currency || null,
      amount_display: r.amount_display || null,
      payment_method: r.payment_method || null,
      next_payment_date: r.next_payment_date || null,
      created_at: r.created_at || null,
      public_url: r.public_url || null,
    }));

    return c.json({
      success: true,
      page,
      page_size,
      total: totalCount,
      count: sanitized.length,
      receipts: sanitized,
      timestamp,
    }, 200);
  } catch (queryErr) {
    console.error('❌ Receipt query failed:', queryErr?.message || queryErr);
    if (queryErr?.response?.data) {
      console.error('📄 Astra error response:', JSON.stringify(queryErr.response.data, null, 2));
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Unable to fetch receipts at this time.',
      timestamp,
    }, 500);
  }
};

export default list;
