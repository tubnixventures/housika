import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

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

  try {
    const result = await bookingsCol.find({ tenant_id: { $eq: user.userId } });
    const data = Object.values(result?.data || {});
    return c.json({
      success: true,
      userId: user.userId,
      count: data.length,
      data,
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
