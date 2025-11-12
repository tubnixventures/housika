import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken, roleCheck } from '../../utils/auth.js';
import { initR2 } from '../../services/r2.js';

/**
 * DELETE /rooms/:id
 * Deletes a room if the requester is the owner or has elevated role.
 * Also deletes associated image from R2 to prevent storage garbage.
 */
export const deleteRoom = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const roomId = c.req.param('id');
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  const elevatedRoles = ['ceo', 'admin', 'customercare'];

  const [authResult, collectionResult] = await Promise.allSettled([
    token ? checkToken(token) : null,
    getCollection('rooms'),
  ]);

  const user = authResult.status === 'fulfilled' ? authResult.value : null;
  const roomsCol = collectionResult.status === 'fulfilled' ? collectionResult.value : null;

  if (!user) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid token.',
      timestamp,
      traceId,
    }, 401);
  }

  if (!roomsCol) {
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

  let room, docId;
  try {
    const result = await roomsCol.find({ room_id: roomId });
    const entries = Object.entries(result?.data || {});
    if (entries.length === 0) {
      return c.json({
        success: false,
        error: 'ROOM_NOT_FOUND',
        message: `No room found with ID "${roomId}".`,
        timestamp,
        traceId,
      }, 404);
    }
    [docId, room] = entries[0];
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Room lookup failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to retrieve room.',
      timestamp,
      traceId,
    }, 500);
  }

  const isOwner = room.landlordId === user.userId;
  const isElevated = roleCheck(user, elevatedRoles);

  if (!isOwner && !isElevated) {
    return c.json({
      success: false,
      error: 'FORBIDDEN',
      message: 'Only the room owner or elevated roles can delete this room.',
      timestamp,
      traceId,
    }, 403);
  }

  // 🧹 Delete image from R2 if present
  const imageUrl = room.image;
  const key = imageUrl?.split('/').slice(-2).join('/');

  try {
    await roomsCol.delete(docId);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Room deletion failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'DELETE_FAILED',
      message: 'Failed to delete room.',
      timestamp,
      traceId,
    }, 500);
  }

  if (key) {
    try {
      const r2 = await initR2();
      await r2.deleteFile(key);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`🧹 Deleted room image from R2: ${key}`);
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('⚠️ Failed to delete image from R2:', err.message || err);
      }
    }
  }

  return c.json({
    success: true,
    message: 'Room and image deleted successfully.',
    room_id: roomId,
    deleted_by: user.userId,
    timestamp,
    traceId,
    audit_ip: c.req.header('x-forwarded-for') || '',
    audit_useragent: c.req.header('user-agent') || '',
  }, 200);
};
