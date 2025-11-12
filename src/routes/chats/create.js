import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';

/**
 * POST /chats
 * Creates a new chat entry in the Astra DB "chats" collection.
 * If an initial message is included, it is stored in the "messages" collection.
 */
export const createChat = async (c) => {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();

  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
  } catch (err) {
    return c.json({
      success: false,
      error: 'BODY_PARSE_FAILED',
      message: 'Request body must be valid JSON.',
      timestamp,
      traceId,
    }, 400);
  }

  const { initialMessage, ...chatData } = body;
  if (Object.keys(chatData).length === 0) {
    return c.json({
      success: false,
      error: 'EMPTY_CHAT',
      message: 'Chat data is empty.',
      timestamp,
      traceId,
    }, 400);
  }

  chatData.createdAt = timestamp;
  chatData.audit_ip = c.req.header('x-forwarded-for') || '';
  chatData.audit_useragent = c.req.header('user-agent') || '';
  chatData.audit_traceid = traceId;

  const [chatsResult, messagesResult] = await Promise.allSettled([
    getCollection('chats'),
    getCollection('messages'),
  ]);

  const chatsCol = chatsResult.status === 'fulfilled' ? chatsResult.value : null;
  const messagesCol = messagesResult.status === 'fulfilled' ? messagesResult.value : null;

  if (!chatsCol || !messagesCol) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ DB connection failed:', chatsResult.reason || messagesResult.reason);
    }
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  let chatId;
  try {
    const result = await chatsCol.insertOne(chatData);
    chatId = result?.insertedId;
    if (!chatId) throw new Error('Chat insert failed.');
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Chat insert failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'CHAT_INSERT_FAILED',
      message: 'Failed to create chat.',
      timestamp,
      traceId,
    }, 500);
  }

  let messageInsertedId = null;
  if (initialMessage && typeof initialMessage === 'object') {
    try {
      const messagePayload = {
        ...initialMessage,
        chatId,
        createdAt: timestamp,
      };
      const msgResult = await messagesCol.insertOne(messagePayload);
      messageInsertedId = msgResult?.insertedId || null;
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('⚠️ Initial message insert failed:', err.message || err);
      }
    }
  }

  return c.json({
    success: true,
    message: 'Chat created successfully.',
    insertedId: chatId,
    messageInsertedId,
    timestamp,
    traceId,
    durationMs: Date.now() - startTime,
  }, 201);
};
