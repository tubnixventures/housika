import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

/**
 * DELETE /countries/:id
 * Deletes a country document. Only CEO can perform this action.
 */
export const deleteCountry = async (c) => {
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
      message: 'Only CEO can delete countries.',
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

  try {
    await countriesCol.deleteOne({ _id: countryId });
    return c.json({
      success: true,
      message: 'Country deleted successfully.',
      country_id: countryId,
      deleted_by: user.userId,
      timestamp,
      traceId,
      audit_ip: c.req.header('x-forwarded-for') || '',
      audit_useragent: c.req.header('user-agent') || '',
    }, 200);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Country deletion failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'DELETE_FAILED',
      message: 'Failed to delete country.',
      timestamp,
      traceId,
    }, 500);
  }
};
