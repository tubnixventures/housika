import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';

/**
 * GET /countries/:id
 * Retrieves a specific country document by its ID.
 */
export const getCountryById = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const countryId = c.req.param('id');

  if (!countryId || typeof countryId !== 'string') {
    return c.json({
      success: false,
      error: 'INVALID_COUNTRY_ID',
      message: 'Country ID must be a valid string.',
      timestamp,
      traceId,
    }, 400);
  }

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

  let country;
  try {
    const result = await countriesCol.find({ _id: countryId });
    country = Object.values(result?.data || {})[0];
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Country lookup failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to retrieve country.',
      timestamp,
      traceId,
    }, 500);
  }

  if (!country) {
    return c.json({
      success: false,
      error: 'COUNTRY_NOT_FOUND',
      message: `No country found with ID "${countryId}".`,
      timestamp,
      traceId,
    }, 404);
  }

  return c.json({
    success: true,
    country_id: countryId,
    data: country,
    timestamp,
    traceId,
  }, 200);
};
