import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken, roleCheck } from '../../utils/auth.js';
import { initR2 } from '../../services/r2.js';

/**
 * DELETE /properties/:id
 * Deletes a property if the requester is the owner or has elevated role.
 * Also deletes associated rooms and cleans up R2 files.
 */
export const deleteProperty = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const propertyId = c.req.param('id');
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  const elevatedRoles = ['ceo', 'admin', 'customercare'];

  const [authResult, propResult, roomResult] = await Promise.allSettled([
    token ? checkToken(token) : null,
    getCollection('properties'),
    getCollection('rooms'),
  ]);

  const user = authResult.status === 'fulfilled' ? authResult.value : null;
  const propertiesCol = propResult.status === 'fulfilled' ? propResult.value : null;
  const roomsCol = roomResult.status === 'fulfilled' ? roomResult.value : null;

  if (!user) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid token.',
      timestamp,
      traceId,
    }, 401);
  }

  if (!propertiesCol || !roomsCol) {
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  let property, docId;
  try {
    const result = await propertiesCol.find({ property_id: { $eq: propertyId } });
    const entries = Object.entries(result?.data || {});
    if (entries.length === 0) {
      return c.json({
        success: false,
        error: 'PROPERTY_NOT_FOUND',
        message: `No property found with ID "${propertyId}".`,
        timestamp,
        traceId,
      }, 404);
    }
    [docId, property] = entries[0];
  } catch (err) {
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to retrieve property.',
      timestamp,
      traceId,
    }, 500);
  }

  const isOwner = property.landlordId === user.userId;
  const isElevated = roleCheck(user, elevatedRoles);

  if (!isOwner && !isElevated) {
    return c.json({
      success: false,
      error: 'FORBIDDEN',
      message: 'Only the property owner or elevated roles can delete this property.',
      timestamp,
      traceId,
    }, 403);
  }

  // 🧹 Delete associated rooms
  let deletedRoomCount = 0;
  try {
    const roomResult = await roomsCol.find({ propertyId: { $eq: propertyId } });
    const rooms = Object.entries(roomResult?.data || {});
    const r2 = await initR2();

    for (const [roomDocId, room] of rooms) {
      const imageKey = room.image?.split('/').slice(-2).join('/');
      await roomsCol.delete(roomDocId);
      deletedRoomCount++;
      if (imageKey) {
        try {
          await r2.deleteFile(imageKey);
        } catch (err) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`⚠️ Failed to delete room image: ${imageKey}`, err.message || err);
          }
        }
      }
    }
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('⚠️ Failed to delete associated rooms:', err.message || err);
    }
  }

  // 🧹 Delete property image
  const propertyImageKey = property.image?.split('/').slice(-2).join('/');
  if (propertyImageKey) {
    try {
      const r2 = await initR2();
      await r2.deleteFile(propertyImageKey);
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`⚠️ Failed to delete property image: ${propertyImageKey}`, err.message || err);
      }
    }
  }

  // 🗑️ Delete property document
  try {
    await propertiesCol.delete(docId);
  } catch (err) {
    return c.json({
      success: false,
      error: 'DELETE_FAILED',
      message: 'Failed to delete property.',
      timestamp,
      traceId,
    }, 500);
  }

  return c.json({
    success: true,
    message: 'Property and associated rooms deleted successfully.',
    property_id: propertyId,
    deleted_rooms: deletedRoomCount,
    deleted_by: user.userId,
    timestamp,
    traceId,
    audit_ip: c.req.header('x-forwarded-for') || '',
    audit_useragent: c.req.header('user-agent') || '',
  }, 200);
};
