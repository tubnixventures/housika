import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken, roleCheck } from '../../utils/auth.js';
import { initR2 } from '../../services/r2.js';
import { uuid } from 'uuidv4';

/**
 * PUT /properties/:id
 * Updates a property and optionally adds rooms.
 * Deletes previous image from R2 if replaced.
 */
export const updateProperty = async (c) => {
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

  let property, docId;
  try {
    const result = await propertiesCol.find({ id: { $eq: propertyId } });
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
      message: 'Only the property owner or elevated roles can update this property.',
      timestamp,
      traceId,
    }, 403);
  }

  const { rooms, ...propertyUpdates } = body;

  // 🧹 Delete old image if replaced
  const oldImageUrl = property.image;
  const newImageUrl = propertyUpdates.image;
  const imageChanged = oldImageUrl && newImageUrl && oldImageUrl !== newImageUrl;

  if (imageChanged) {
    const key = oldImageUrl.split('/').slice(-2).join('/');
    try {
      const r2 = await initR2();
      await r2.deleteFile(key);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`🧹 Deleted old property image from R2: ${key}`);
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('⚠️ Failed to delete old image from R2:', err.message || err);
      }
    }
  }

  try {
    await propertiesCol.patch(docId, {
      ...propertyUpdates,
      updated_by: user.userId,
      updated_at: timestamp,
      audit_traceid: traceId,
    });
  } catch (err) {
    return c.json({
      success: false,
      error: 'UPDATE_FAILED',
      message: 'Failed to update property.',
      timestamp,
      traceId,
    }, 500);
  }

  let roomsAdded = 0;
  if (Array.isArray(rooms)) {
    try {
      const roomInsertions = rooms.map((room, index) => {
        const { name, size, ensuite, amenities } = room;
        if (!name || !size) {
          throw new Error(`Room ${index + 1} missing required fields (name, size).`);
        }

        const roomId = uuid();
        return roomsCol.post({
          room_id: roomId,
          propertyId,
          name,
          size,
          ensuite: Boolean(ensuite),
          amenities: Array.isArray(amenities) ? amenities : [],
          createdAt: timestamp,
        });
      });

      const results = await Promise.all(roomInsertions);
      roomsAdded = results.length;
    } catch (err) {
      return c.json({
        success: false,
        error: 'ROOM_INSERT_FAILED',
        message: err.message || 'Failed to add rooms.',
        timestamp,
        traceId,
      }, 500);
    }
  }

  return c.json({
    success: true,
    message: 'Property updated successfully.',
    propertyId,
    roomsAdded,
    timestamp,
    traceId,
  }, 200);
};
