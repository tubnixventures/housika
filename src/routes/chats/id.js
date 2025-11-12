import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';

/**
 * GET /chats/:id
 * Returns all messages for a specific chat from the "messages" collection.
 * Powers the chatroom screen (non-realtime).
 */
export const getMessagesForChat = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const chatId = c.req.param('id');

  if (!chatId || typeof chatId !== 'string') {
    return c.json({
      success: false,
      error: 'INVALID_CHAT_ID',
      message: 'Chat ID must be a valid string.',
      timestamp,
      traceId,
    }, 400);
  }

  let messagesCol;
  try {
    messagesCol = await getCollection('messages');
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

  let messages = [];
  try {
    const result = await messagesCol.find({ chatId: { $eq: chatId } });
    messages = Object.values(result?.data || {});
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Message query failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to retrieve chat messages.',
      timestamp,
      traceId,
    }, 500);
  }

  return c.json({
    success: true,
    chatId,
    count: messages.length,
    data: messages,
    timestamp,
    traceId,
  }, 200);
};
