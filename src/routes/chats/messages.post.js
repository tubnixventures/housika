import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';

const CHAT_COLLECTION = 'chats';
const MESSAGE_COLLECTION = 'messages';
const MAX_MESSAGE_BYTES = 50_000; // hardcoded limit for message payload
const DEFAULT_ATOMIC_MESSAGE_CREATE = true; // hardcoded: if true, rollback chat update on message write failure

function nowIso() {
  return new Date().toISOString();
}

function makeLogger(traceId) {
  return {
    info: (...args) => console.info({ traceId, ts: nowIso(), pid: process.pid }, ...args),
    warn: (...args) => console.warn({ traceId, ts: nowIso(), pid: process.pid }, ...args),
    error: (...args) => console.error({ traceId, ts: nowIso(), pid: process.pid }, ...args),
  };
}

function sanitizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const msg = {};
  if (raw.body && typeof raw.body === 'string') msg.body = raw.body.trim();
  if (raw.type && typeof raw.type === 'string') msg.type = raw.type;
  if (raw.metadata && typeof raw.metadata === 'object') msg.metadata = raw.metadata;
  return Object.keys(msg).length ? msg : null;
}

function validateMessageSize(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_MESSAGE_BYTES;
}

/**
 * POST /chats/:id/messages
 * - Expects authenticated request (c.state.user) or x-user-id header
 * - Body: { body: string, type?: string, metadata?: object }
 * - Writes message to messages collection, updates parent chat (updatedAt, lastMessage)
 * - Returns created message id and updated chat id
 */
export const postMessageToChat = async (c) => {
  const start = Date.now();
  const timestamp = nowIso();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const log = makeLogger(traceId);

  // Auth / tenant inference (integrate with your auth middleware)
  const authUser = c.state?.user || null;
  const userId = authUser?.id || c.req.header('x-user-id') || null;
  const tenantId = authUser?.tenantId || c.req.header('x-tenant-id') || null;
  if (!userId) {
    log.warn('Unauthenticated request attempted to post message');
    return c.json({
      success: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication required to post messages.',
      timestamp,
      traceId,
    }, 401);
  }

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

  // Parse and validate body
  let bodyRaw;
  try {
    bodyRaw = await c.req.json();
    if (!bodyRaw || typeof bodyRaw !== 'object') throw new Error('Invalid JSON');
  } catch (err) {
    log.warn('Body parse failed', { err: err?.message || err });
    return c.json({
      success: false,
      error: 'BODY_PARSE_FAILED',
      message: 'Request body must be valid JSON.',
      timestamp,
      traceId,
    }, 400);
  }

  const message = sanitizeMessage(bodyRaw);
  if (!message || !message.body) {
    return c.json({
      success: false,
      error: 'INVALID_MESSAGE',
      message: 'Message must contain a non-empty body.',
      timestamp,
      traceId,
    }, 400);
  }

  if (!validateMessageSize(message)) {
    return c.json({
      success: false,
      error: 'MESSAGE_TOO_LARGE',
      message: 'Message payload exceeds allowed size.',
      timestamp,
      traceId,
    }, 413);
  }

  // Collections
  let chatsCol, messagesCol;
  try {
    const [chatsResult, messagesResult] = await Promise.allSettled([
      getCollection(CHAT_COLLECTION),
      getCollection(MESSAGE_COLLECTION),
    ]);
    chatsCol = chatsResult.status === 'fulfilled' ? chatsResult.value : null;
    messagesCol = messagesResult.status === 'fulfilled' ? messagesResult.value : null;
    if (!chatsCol || !messagesCol) {
      log.error('DB collection retrieval failed', {
        chatsReason: chatsResult.reason,
        messagesReason: messagesResult.reason,
      });
      return c.json({
        success: false,
        error: 'DB_CONNECTION_FAILED',
        message: 'Unable to reach database.',
        timestamp,
        traceId,
      }, 503);
    }
  } catch (err) {
    log.error('Unexpected DB connection error', { err: err?.message || err });
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Unable to reach database.',
      timestamp,
      traceId,
    }, 503);
  }

  // Verify chat exists and user is allowed (tenant + participant check)
  let chatDoc;
  try {
    const chatRes = await chatsCol.find({ _id: { $eq: chatId } }, { limit: 1 });
    const docs = Array.isArray(chatRes) ? chatRes : Array.isArray(chatRes?.data) ? chatRes.data : Object.values(chatRes?.data || {});
    chatDoc = docs[0] || null;
    if (!chatDoc) {
      return c.json({
        success: false,
        error: 'CHAT_NOT_FOUND',
        message: 'Chat not found.',
        timestamp,
        traceId,
      }, 404);
    }
  } catch (err) {
    log.error('Chat lookup failed', { err: err?.message || err, chatId });
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to validate chat.',
      timestamp,
      traceId,
    }, 500);
  }

  // Tenant enforcement (marketplace)
  if (tenantId && chatDoc.tenantId && tenantId !== chatDoc.tenantId) {
    log.warn('Tenant mismatch', { tenantId, chatTenant: chatDoc.tenantId, userId, chatId });
    return c.json({
      success: false,
      error: 'FORBIDDEN',
      message: 'Not allowed to post to this chat.',
      timestamp,
      traceId,
    }, 403);
  }

  // Participant enforcement: ensure user is in chat participants
  const isParticipant = Array.isArray(chatDoc.participants) && chatDoc.participants.some(p => p?.userId === userId);
  if (!isParticipant) {
    log.warn('User not a participant', { userId, chatId });
    return c.json({
      success: false,
      error: 'FORBIDDEN',
      message: 'You are not a participant in this chat.',
      timestamp,
      traceId,
    }, 403);
  }

  // Build message payload
  const messagePayload = {
    ...message,
    chatId,
    tenantId: chatDoc.tenantId || tenantId || null,
    createdAt: timestamp,
    createdBy: userId,
    audit: {
      ip: c.req.header('x-forwarded-for') || c.req.ip || '',
      userAgent: c.req.header('user-agent') || '',
      traceId,
    },
  };

  // Insert message
  let insertedMessageId = null;
  try {
    const res = await messagesCol.insertOne(messagePayload);
    insertedMessageId = res?.insertedId || null;
    if (!insertedMessageId) throw new Error('Message insert returned no id');
  } catch (err) {
    log.error('Message insert failed', { err: err?.message || err, chatId, userId });
    return c.json({
      success: false,
      error: 'MESSAGE_INSERT_FAILED',
      message: 'Failed to save message.',
      timestamp,
      traceId,
    }, 500);
  }

  // Update chat metadata (updatedAt, lastMessage preview). If this update fails and atomic mode is on, attempt rollback.
  const chatUpdate = {
    updatedAt: timestamp,
    lastMessage: {
      body: messagePayload.body,
      type: messagePayload.type || 'text',
      createdAt: messagePayload.createdAt,
      createdBy: messagePayload.createdBy,
      messageId: insertedMessageId,
    },
  };

  try {
    const updRes = await chatsCol.updateOne({ _id: { $eq: chatId } }, { $set: chatUpdate });
    // depending on driver shape, you may want to check matchedCount/modifiedCount
    if (!updRes || !(updRes.matchedCount || updRes.modifiedCount || updRes?.ok)) {
      throw new Error('Chat update returned unexpected result');
    }
  } catch (err) {
    log.warn('Chat update failed after message insert', { err: err?.message || err, chatId, messageId: insertedMessageId });
    if (DEFAULT_ATOMIC_MESSAGE_CREATE) {
      try {
        await messagesCol.deleteOne({ _id: { $eq: insertedMessageId } });
        log.warn('Rolled back message after chat update failure', { messageId: insertedMessageId, chatId });
        return c.json({
          success: false,
          error: 'CHAT_UPDATE_FAILED',
          message: 'Failed to update chat after saving message; message rolled back.',
          timestamp,
          traceId,
        }, 500);
      } catch (delErr) {
        log.error('Rollback failed', { delErr: delErr?.message || delErr, messageId: insertedMessageId, chatId });
        return c.json({
          success: false,
          error: 'PARTIAL_FAILURE',
          message: 'Message saved but chat update failed; rollback also failed.',
          timestamp,
          traceId,
        }, 500);
      }
    } else {
      // Non-atomic: still succeed but inform client that chat metadata was not updated.
      return c.json({
        success: true,
        message: 'Message saved but chat metadata update failed.',
        messageId: insertedMessageId,
        chatId,
        timestamp,
        traceId,
        durationMs: Date.now() - start,
      }, 201);
    }
  }

  // Success
  log.info('Message created', { chatId, messageId: insertedMessageId });
  return c.json({
    success: true,
    message: 'Message posted successfully.',
    messageId: insertedMessageId,
    chatId,
    timestamp,
    traceId,
    durationMs: Date.now() - start,
  }, 201);
};
