import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';

/**
 * POST /rooms/find
 * Dynamically filters rooms and properties based on frontend-provided criteria.
 * Supports search across both collections and merges results.
 */
const find = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();

  let filters;
  try {
    filters = await c.req.json();
    if (!filters || typeof filters !== 'object') throw new Error('Invalid JSON');
  } catch (err) {
    return c.json({
      success: false,
      error: 'INVALID_FILTERS',
      message: 'Request body must be valid JSON.',
      timestamp,
      traceId,
    }, 400);
  }

  const [propertiesResult, roomsResult] = await Promise.allSettled([
    getCollection('properties'),
    getCollection('rooms'),
  ]);

  const propertiesCol = propertiesResult.status === 'fulfilled' ? propertiesResult.value : null;
  const roomsCol = roomsResult.status === 'fulfilled' ? roomsResult.value : null;

  if (!propertiesCol || !roomsCol) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ DB connection failed:', propertiesResult.reason || roomsResult.reason);
    }
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  const propertyQuery = {};
  const roomQuery = {};

  // Property-level filters
  if (filters.location) propertyQuery.location = { $eq: filters.location };
  if (filters.exact_location) propertyQuery.exact_location = { $eq: filters.exact_location };
  if (filters.description) propertyQuery.description = { $contains: filters.description };
  if (filters.country) propertyQuery.country = { $eq: filters.country };
  if (filters.latitude) propertyQuery.latitude = { $eq: filters.latitude };
  if (filters.longitude) propertyQuery.longitude = { $eq: filters.longitude };
  if (filters.property_name) propertyQuery.title = { $contains: filters.property_name };

  // Room-level filters
  if (filters.currency) roomQuery.currency = { $eq: filters.currency };
  if (filters.amount) roomQuery.amount = { $lte: filters.amount };
  if (filters.period) roomQuery.period = { $eq: filters.period };
  if (filters.category) roomQuery.category = { $eq: filters.category };

  let matchedProperties = [];
  let matchedRooms = [];

  try {
    const [propertyResult, roomResult] = await Promise.all([
      propertiesCol.find(propertyQuery),
      roomsCol.find(roomQuery),
    ]);
    matchedProperties = Object.values(propertyResult?.data || {});
    matchedRooms = Object.values(roomResult?.data || {});
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Query execution failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'QUERY_FAILED',
      message: 'Failed to execute search queries.',
      timestamp,
      traceId,
    }, 500);
  }

  const linkByPropertyId = filters.linked === true;
  const enrichedRooms = linkByPropertyId
    ? matchedRooms.map((room) => ({
        ...room,
        property: matchedProperties.find((p) => p.property_id === room.propertyId) || null,
      }))
    : matchedRooms;

  return c.json({
    success: true,
    filters,
    matched: {
      properties: matchedProperties.length,
      rooms: matchedRooms.length,
    },
    data: {
      properties: matchedProperties,
      rooms: enrichedRooms,
    },
    timestamp,
    traceId,
  }, 200);
};

export default find;
