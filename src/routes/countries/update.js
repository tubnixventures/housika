import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

/**
 * PUT /countries/:id
 * Updates a country document. Only CEO can perform this action.
 */
export const updateCountry = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const countryId = c.req.param('id');
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  const [userResult, collectionResult] = await Promise.allSettled([
    token ? checkToken(token) : null,
    getCollection('countries'),
  ]);

  const user = userResult.status === 'fulfilled' ? userResult.value : null;
  const countriesCol = collectionResult.status === 'fulfilled' ? collectionResult.value : null;

  if (!user || user.role !== 'ceo') {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only CEO can update countries.',
      timestamp,
      traceId,
    }, 403);
  }

  if (!countriesCol) {
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

  const updatePayload = {
    ...body,
    updated_by: user.userId,
    updated_at: timestamp,
    audit_ip: c.req.header('x-forwarded-for') || '',
    audit_useragent: c.req.header('user-agent') || '',
    audit_traceid: traceId,
  };

  try {
    await countriesCol.patch(countryId, updatePayload);
    return c.json({
      success: true,
      message: 'Country updated successfully.',
      country_id: countryId,
      updated_fields: Object.keys(body),
      timestamp,
      traceId,
    }, 200);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Country update failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'UPDATE_FAILED',
      message: 'Failed to update country.',
      timestamp,
      traceId,
    }, 500);
  }
};
