import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';

/**
 * GET /countries
 * Returns all countries from the Astra DB "countries" collection.
 * Public access.
 */
export const getCountries = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();

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
      message: 'Unable to connect to countries collection.',
      timestamp,
      traceId,
    }, 503);
  }

  let countries = [];
  try {
    const result = await countriesCol.find({});
    countries = Object.values(result?.data || {});
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Country fetch failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'FETCH_ERROR',
      message: 'Unable to retrieve countries at this time.',
      timestamp,
      traceId,
    }, 500);
  }

  return c.json({
    success: true,
    count: countries.length,
    data: countries,
    timestamp,
    traceId,
  }, 200);
};
