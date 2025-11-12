import { getCollection } from '../../services/astra.js';

// ✅ UUID v4 format validator
const isUUID = (id) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * GET /properties/:id
 * Returns a specific property, its rooms, and its reviews.
 */
export const getPropertyById = async (c) => {
  const timestamp = new Date().toISOString();
  const propertyId = c.req.param('id');

  if (!propertyId || !isUUID(propertyId)) {
    return c.json({
      success: false,
      error: 'INVALID_PROPERTY_ID',
      message: 'Property ID must be a valid UUID.',
      timestamp,
    }, 400);
  }

  let propertiesCollection, roomsCollection, reviewsCollection;
  try {
    [propertiesCollection, roomsCollection, reviewsCollection] = await Promise.all([
      getCollection('properties'),
      getCollection('rooms'),
      getCollection('reviews'),
    ]);
  } catch (err) {
    console.error('❌ DB connection error:', err.message || err);
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
    }, 503);
  }

  let property;
  try {
    const result = await propertiesCollection.find({ property_id: { $eq: propertyId } });
    property = Object.values(result?.data || {})[0];

    if (!property) {
      return c.json({
        success: false,
        error: 'PROPERTY_NOT_FOUND',
        message: `No property found with ID "${propertyId}".`,
        timestamp,
      }, 404);
    }
  } catch (err) {
    console.error(`❌ Property query failed for ID ${propertyId}:`, err.message || err);
    return c.json({
      success: false,
      error: 'PROPERTY_QUERY_FAILED',
      message: 'Failed to retrieve property.',
      timestamp,
    }, 500);
  }

  let rooms = [], reviews = [];
  try {
    const [roomResult, reviewResult] = await Promise.all([
      roomsCollection.find({ property_id: { $eq: propertyId } }),
      reviewsCollection.find({ property_id: { $eq: propertyId }, status: { $eq: 'active' } }),
    ]);
    rooms = Object.values(roomResult?.data || {});
    reviews = Object.values(reviewResult?.data || {}).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  } catch (err) {
    console.warn(`⚠️ Room or review query failed for property_id ${propertyId}:`, err.message || err);
  }

  return c.json({
    success: true,
    data: {
      property,
      rooms,
      reviews,
    },
    timestamp,
  });
};
