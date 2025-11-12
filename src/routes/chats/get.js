import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';

/**
 * GET /chats
 * Returns all chat entries from the Astra DB "chats" collection.
 * Currently open access — no user filtering yet.
 */
export const getChats = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();

  let chatsCol;
  try {
    chatsCol = await getCollection('chats');
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

  let chats = [];
  try {
    const result = await chatsCol.find({});
    chats = Object.values(result?.data || {});
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Chat query failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Unable to retrieve chats at this time.',
      timestamp,
      traceId,
    }, 500);
  }

  return c.json({
    success: true,
    count: chats.length,
    data: chats,
    timestamp,
    traceId,
  }, 200);
};
