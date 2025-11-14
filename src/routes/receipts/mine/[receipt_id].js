// src/routes/receipts/mine/[receipt_id].js
import { getCollection } from '../../../services/astra.js';
import { checkToken } from '../../../utils/auth.js';

const ALLOWED_ROLES = new Set(['landlord', 'dual']);

/**
 * GET /receipts/mine/:receipt_id
 * Handler exported as a function named `mine`.
 * - Enforces auth + ownership
 * - Returns sanitized, currency-aware receipt fields
 */
export const mine = async (c) => {
  const timestamp = new Date().toISOString();
  const receiptId = String(c.req.param('receipt_id') || '').trim();

  // Auth
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const user = token ? await checkToken(token) : null;
  if (!user || !ALLOWED_ROLES.has(user.role)) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only landlords or dual-role users can access their receipts.',
      timestamp,
    }, 403);
  }

  // Validate receipt id
  if (!receiptId || typeof receiptId !== 'string' || !receiptId.startsWith('RCT-')) {
    return c.json({
      success: false,
      error: 'INVALID_RECEIPT_ID',
      message: 'Receipt ID is required and must start with "RCT-".',
      timestamp,
    }, 400);
  }

  // DB connection
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

  // Query receipt by id and owner
  try {
    const result = await receiptsCol.find({
      receipt_id: receiptId,
      created_by: user.userId,
    });

    const receipt = Object.values(result?.data || {})[0];

    if (!receipt) {
      return c.json({
        success: false,
        error: 'RECEIPT_NOT_FOUND',
        message: 'Receipt not found or does not belong to you.',
        timestamp,
      }, 404);
    }

    // Sanitize canonical response
    const sanitized = {
      receipt_id: receipt.receipt_id,
      receipt_number: receipt.receipt_number || null,
      tenant_name: receipt.tenant_name || null,
      property_name: receipt.property_name || null,
      amount_value: typeof receipt.amount_value !== 'undefined' ? receipt.amount_value : null,
      amount_currency: receipt.amount_currency || null,
      amount_display: receipt.amount_display || null,
      payment_method: receipt.payment_method || null,
      next_payment_date: receipt.next_payment_date || null,
      details: receipt.details || null,
      public_url: receipt.public_url || null,
      download_url: receipt.download_url || null,
      created_at: receipt.created_at || null,
      created_by: receipt.created_by || null,
      created_role: receipt.created_role || null,
      trace_id: receipt.trace_id || null,
    };

    return c.json({
      success: true,
      receipt: sanitized,
      timestamp,
    }, 200);
  } catch (queryErr) {
    console.error('❌ Receipt lookup failed:', queryErr?.message || queryErr);
    if (queryErr?.response?.data) {
      console.error('📄 Astra error response:', JSON.stringify(queryErr.response.data, null, 2));
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Unable to retrieve receipt at this time.',
      timestamp,
    }, 500);
  }
};

export default mine;
