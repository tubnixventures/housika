import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';

/**
 * POST /countries
 * Creates a new country entry in the Astra DB "countries" collection.
 * Generates a unique country_id for each entry.
 */
export const createCountry = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();

  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
  } catch (err) {
    return c.json({
      success: false,
      error: 'INVALID_BODY',
      message: 'Request body must be valid JSON.',
      timestamp,
      traceId,
    }, 400);
  }

  const country_id = `CTR-${crypto.randomUUID()}`;
  const payload = {
    country_id,
    ...body,
    created_at: timestamp,
    audit_traceid: traceId,
  };

  let countriesCol;
  try {
    countriesCol = await getCollection('countries');
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ DB connection failed:', err.message || err);
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
    const result = await countriesCol.post(payload);
    return c.json({
      success: true,
      message: 'Country created successfully.',
      country_id,
      insertedId: result?.documentId || null,
      timestamp,
      traceId,
    }, 201);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Country insert failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'INSERT_FAILED',
      message: 'Failed to create country.',
      timestamp,
      traceId,
    }, 500);
  }
};
