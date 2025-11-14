// src/routes/receipts/verify.js
import { getCollection } from '../../services/astra.js';

/**
 * GET /receipts/verify/:receipt_identifier
 * Supports verification by:
 *  - receipt_id (internal UUID prefixed with RCT-)
 *  - receipt_number (short 10-digit human-verifiable number)
 *
 * Returns canonical receipt record with normalized currency fields:
 *  - amount_value (integer, smallest unit)
 *  - amount_currency (ISO 4217)
 *  - amount_display (preformatted string)
 */
const verify = async (c) => {
  const timestamp = new Date().toISOString();
  const identifier = String(c.req.param('receipt_identifier') || '').trim();

  if (!identifier) {
    return c.json({
      success: false,
      error: 'MISSING_IDENTIFIER',
      message: 'Receipt identifier is required.',
      timestamp,
    }, 400);
  }

  // Validate shapes quickly: either "RCT-" prefixed receipt_id or a 6-12 digit receipt_number
  const isReceiptId = identifier.startsWith('RCT-');
  const isReceiptNumber = /^[0-9]{6,12}$/.test(identifier);

  if (!isReceiptId && !isReceiptNumber) {
    return c.json({
      success: false,
      error: 'INVALID_IDENTIFIER',
      message: 'Identifier must be a receipt_id starting with "RCT-" or the short numeric receipt_number.',
      timestamp,
    }, 400);
  }

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
    // Query by appropriate field
    let queryResult;
    if (isReceiptId) {
      // find by receipt_id
      queryResult = await receiptsCol.find({ receipt_id: identifier });
    } else {
      // find by short receipt_number
      queryResult = await receiptsCol.find({ receipt_number: identifier });
    }

    const receipt = Object.values(queryResult?.data || {})[0];

    if (!receipt) {
      return c.json({
        success: false,
        error: 'RECEIPT_NOT_FOUND',
        message: 'Receipt not found or invalid.',
        timestamp,
      }, 404);
    }

    // Build canonical verification response with normalized currency fields
    const response = {
      success: true,
      verified: true,
      receipt_id: receipt.receipt_id,
      receipt_number: receipt.receipt_number || null,
      tenant_name: receipt.tenant_name || null,
      property_name: receipt.property_name || null,
      issued_by: receipt.created_by || null,
      issued_role: receipt.created_role || null,
      issued_at: receipt.created_at || null,
      next_payment_date: receipt.next_payment_date || null,
      details: receipt.details || null,
      public_url: receipt.public_url || null,
      verify_url: `https://housika.io/verify?receipt_id=${encodeURIComponent(receipt.receipt_id)}`,
      // New currency-aware fields
      amount_value: (typeof receipt.amount_value !== 'undefined') ? receipt.amount_value : null,
      amount_currency: receipt.amount_currency || null,
      amount_display: receipt.amount_display || null,
      // Audit
      trace_id: receipt.trace_id || null,
      timestamp,
    };

    return c.json(response, 200);
  } catch (queryErr) {
    console.error('❌ Receipt lookup failed:', queryErr?.message || queryErr);
    if (queryErr?.response?.data) {
      console.error('📄 Astra error response:', JSON.stringify(queryErr.response.data, null, 2));
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Unable to verify receipt at this time.',
      timestamp,
    }, 500);
  }
};

export default verify;
