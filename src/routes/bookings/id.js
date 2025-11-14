// id.js
import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

/**
 * GET /bookings/:id
 * - Returns a single booking by booking_id
 * - Access:
 *   - admin, ceo, customercare can fetch any booking
 *   - landlord can fetch bookings where booking.landlord_id === actor.userId
 *   - tenant can fetch bookings where booking.tenant_id === actor.userId
 */
const getBookingById = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const bookingId = c.req.param('id');
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  if (!token || typeof bookingId !== 'string' || bookingId.trim() === '') {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED_OR_INVALID_ID',
      message: 'Missing token or invalid booking ID.',
      timestamp,
      traceId,
    }, 401);
  }

  // Resolve token and bookings collection in parallel
  const [actorResult, collectionResult] = await Promise.allSettled([
    checkToken(token),
    getCollection('bookings'),
  ]);

  const actor = actorResult.status === 'fulfilled' ? actorResult.value : null;
  const bookingsCol = collectionResult.status === 'fulfilled' ? collectionResult.value : null;

  if (!actor?.userId) {
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
    const result = await bookingsCol.find({ booking_id: { $eq: bookingId } });
    const booking = Object.values(result?.data || {})[0];

    if (!booking) {
      return c.json({
        success: false,
        error: 'BOOKING_NOT_FOUND',
        message: `No booking found with ID "${bookingId}".`,
        timestamp,
        traceId,
      }, 404);
    }

    // Authorization: admin / ceo / customercare can access any booking
    const privilegedRoles = ['admin', 'ceo', 'customercare'];
    const actorRole = String(actor.role || actor?.role || '').toLowerCase();
    const isPrivileged = privilegedRoles.includes(actorRole);

    const isLandlord = booking.landlord_id && booking.landlord_id === actor.userId;
    const isTenant = booking.tenant_id && booking.tenant_id === actor.userId;

    if (!isPrivileged && !isLandlord && !isTenant) {
      return c.json({
        success: false,
        error: 'FORBIDDEN',
        message: 'You are not authorized to view this booking.',
        timestamp,
        traceId,
      }, 403);
    }

    return c.json({
      success: true,
      booking,
      booking_id: bookingId,
      role: actor.role || actor?.role || '',
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
      message: 'Failed to retrieve booking.',
      timestamp,
      traceId,
    }, 500);
  }
};

export default getBookingById;
