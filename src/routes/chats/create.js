import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';

const DEFAULT_ATOMIC_CREATE = true; // hardcoded for production atomic behaviour
const CHAT_COLLECTION = 'chats';
const MESSAGE_COLLECTION = 'messages';
const MAX_PAYLOAD_BYTES = 200_000; // hardcoded payload limit in bytes

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

function validateChatPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'PAYLOAD_INVALID';
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) return 'PAYLOAD_TOO_LARGE';

  const { tenantId, participants, type } = payload;
  if (!tenantId || typeof tenantId !== 'string') return 'MISSING_TENANT';
  if (!Array.isArray(participants) || participants.length < 1) return 'MISSING_PARTICIPANTS';
  if (!participants.every(p => p && typeof p.userId === 'string')) return 'INVALID_PARTICIPANTS';
  if (type && typeof type !== 'string') return 'INVALID_TYPE';
  return null;
}

function sanitizeInitialMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const allowed = {};
  if (msg.body && typeof msg.body === 'string') allowed.body = msg.body.trim();
  if (msg.type && typeof msg.type === 'string') allowed.type = msg.type;
  if (msg.metadata && typeof msg.metadata === 'object') allowed.metadata = msg.metadata;
  return Object.keys(allowed).length ? allowed : null;
}

/**
 * POST /chats
 * Production-ready: creates a chat and optionally initial message for a marketplace.
 */
export const createChat = async (c) => {
  const startTime = Date.now();
  const timestamp = nowIso();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const log = makeLogger(traceId);

  const authUser = c.state?.user || null;
  const authUserId = authUser?.id || c.req.header('x-user-id') || null;

  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
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

  const validationError = validateChatPayload(body);
  if (validationError) {
    log.warn('Payload validation failed', { validationError });
    return c.json({
      success: false,
      error: validationError,
      message: 'Invalid chat payload.',
      timestamp,
      traceId,
    }, 400);
  }

  const initialMessageRaw = body.initialMessage;
  delete body.initialMessage;
  const chatData = { ...body };

  chatData.createdAt = timestamp;
  chatData.createdBy = authUserId || 'anonymous';
  chatData.audit = {
    ip: c.req.header('x-forwarded-for') || c.req.ip || '',
    userAgent: c.req.header('user-agent') || '',
    traceId,
  };
  chatData._meta = {
    version: 1,
    source: 'marketplace-api',
  };

  let chatsCol;
  let messagesCol;
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

  let chatId;
  try {
    const result = await chatsCol.insertOne(chatData);
    chatId = result?.insertedId;
    if (!chatId) throw new Error('No insertedId returned');
  } catch (err) {
    log.error('Chat insert failed', { err: err?.message || err });
    return c.json({
      success: false,
      error: 'CHAT_INSERT_FAILED',
      message: 'Failed to create chat.',
      timestamp,
      traceId,
    }, 500);
  }

  const initialMessage = sanitizeInitialMessage(initialMessageRaw);
  if (!initialMessage) {
    log.info('Chat created without initial message', { chatId });
    return c.json({
      success: true,
      message: 'Chat created successfully.',
      insertedId: chatId,
      messageInsertedId: null,
      timestamp,
      traceId,
      durationMs: Date.now() - startTime,
    }, 201);
  }

  const messagePayload = {
    ...initialMessage,
    chatId,
    tenantId: chatData.tenantId,
    createdAt: timestamp,
    createdBy: authUserId || 'anonymous',
    audit: {
      traceId,
      ip: chatData.audit.ip,
      userAgent: chatData.audit.userAgent,
    },
  };

  let messageInsertedId = null;
  try {
    const msgResult = await messagesCol.insertOne(messagePayload);
    messageInsertedId = msgResult?.insertedId || null;
  } catch (err) {
    log.warn('Initial message insert failed', { err: err?.message || err, chatId });
    if (DEFAULT_ATOMIC_CREATE) {
      try {
        await chatsCol.deleteOne({ _id: chatId });
        log.warn('Rolled back chat due to message insert failure', { chatId });
        return c.json({
          success: false,
          error: 'MESSAGE_INSERT_FAILED',
          message: 'Failed to create initial message; chat creation rolled back.',
          timestamp,
          traceId,
        }, 500);
      } catch (delErr) {
        log.error('Rollback failed after message insert failure', { delErr: delErr?.message || delErr, chatId });
        return c.json({
          success: false,
          error: 'PARTIAL_FAILURE',
          message: 'Chat created but initial message failed; rollback also failed.',
          timestamp,
          traceId,
        }, 500);
      }
    } else {
      return c.json({
        success: true,
        message: 'Chat created; initial message failed to save.',
        insertedId: chatId,
        messageInsertedId: null,
        timestamp,
        traceId,
        durationMs: Date.now() - startTime,
      }, 201);
    }
  }

  log.info('Chat and initial message created', { chatId, messageInsertedId });
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
