import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

/**
 * PUT /bookings/:id
 * Allows landlord to update booking status or extend stay.
 * Only the landlord of the booking can perform this update.
 */
export const updateBooking = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const bookingId = c.req.param('id');
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  if (!token || typeof bookingId !== 'string') {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED_OR_INVALID_ID',
      message: 'Missing token or invalid booking ID.',
      timestamp,
      traceId,
    }, 401);
  }

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

  let updateData;
  try {
    updateData = await c.req.json();
    if (!updateData || typeof updateData !== 'object') throw new Error('Invalid JSON');
  } catch (err) {
    return c.json({
      success: false,
      error: 'INVALID_BODY',
      message: 'Request body must be valid JSON.',
      timestamp,
      traceId,
    }, 400);
  }

  let booking;
  try {
    const result = await bookingsCol.find({ booking_id: { $eq: bookingId } });
    booking = Object.values(result?.data || {})[0];
    if (!booking) {
      return c.json({
        success: false,
        error: 'BOOKING_NOT_FOUND',
        message: `No booking found with ID "${bookingId}".`,
        timestamp,
        traceId,
      }, 404);
    }
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

  if (booking.landlord_id !== actor.userId) {
    return c.json({
      success: false,
      error: 'FORBIDDEN',
      message: 'Only the landlord of this booking can update it.',
      timestamp,
      traceId,
    }, 403);
  }

  const allowedFields = ['status', 'new_checkout_date', 'notes'];
  const updatePayload = Object.fromEntries(
    allowedFields
      .filter((key) => Object.prototype.hasOwnProperty.call(updateData, key))
      .map((key) => [key, updateData[key]])
  );

  if (Object.keys(updatePayload).length === 0) {
    return c.json({
      success: false,
      error: 'NO_VALID_FIELDS',
      message: 'No valid fields provided for update.',
      timestamp,
      traceId,
    }, 400);
  }

  updatePayload.updated_by = actor.userId;
  updatePayload.updated_at = timestamp;
  updatePayload.audit_ip = c.req.header('x-forwarded-for') || '';
  updatePayload.audit_useragent = c.req.header('user-agent') || '';
  updatePayload.audit_traceid = traceId;

  try {
    await bookingsCol.patch(booking._id, updatePayload);
    return c.json({
      success: true,
      message: 'Booking updated successfully.',
      updatedFields: Object.keys(updatePayload),
      booking_id: bookingId,
      timestamp,
      traceId,
    }, 200);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Booking update failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'UPDATE_FAILED',
      message: 'Failed to update booking.',
      timestamp,
      traceId,
    }, 500);
  }
};
