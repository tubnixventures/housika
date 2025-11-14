import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';

const CHAT_COLLECTION = 'chats';
const MESSAGE_COLLECTION = 'messages';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

/**
 * GET /chats
 * - Returns paginated chats.
 * - Each chat contains only the newest (latest) message as `latestMessage`.
 * - Supports tenant scoping and optional participant filtering.
 * - Defensive: validates params, protects against large limits, structured logs and traceId.
 */
export const getChats = async (c) => {
  const timestamp = nowIso();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const log = makeLogger(traceId);

  // Basic auth/tenant inference (replace with real auth middleware integration)
  const authUser = c.state?.user || null;
  const authUserId = authUser?.id || c.req.header('x-user-id') || null;

  // Query params
  const q = c.req.query || {};
  const tenantId = q.tenantId || (authUser?.tenantId) || null;
  const participantId = q.participantId || null;
  let limit = parseInt(q.limit, 10) || DEFAULT_LIMIT;
  let page = Math.max(1, parseInt(q.page, 10) || 1);
  const since = q.since || null; // optional ISO date to only return chats updated after 'since'

  // Sanitize limit
  if (limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  // Build chat filter (require tenantId in production)
  const chatFilter = {};
  if (tenantId) chatFilter.tenantId = tenantId;
  if (participantId) chatFilter['participants.userId'] = participantId;
  if (since) {
    const d = new Date(since);
    if (!isNaN(d)) chatFilter.updatedAt = { $gte: d.toISOString() };
  }

  // Get collections defensively
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

  // Fetch chats page (only core fields to reduce payload)
  let chatsPage = [];
  let totalCount = 0;
  try {
    const skip = (page - 1) * limit;
    const projection = { /* adjust fields as needed */ name: 1, tenantId: 1, participants: 1, createdAt: 1, updatedAt: 1 };
    // Depending on getCollection API shape, adapt below find usage. Here we assume .find supports filter, options and returns { data, total } shape.
    const result = await chatsCol.find(chatFilter, { projection, limit, skip, sort: { updatedAt: -1 } });
    chatsPage = Array.isArray(result?.data) ? result.data : Object.values(result?.data || {});
    totalCount = typeof result?.total === 'number' ? result.total : chatsPage.length;
  } catch (err) {
    log.error('Chat query failed', { err: err?.message || err });
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Unable to retrieve chats at this time.',
      timestamp,
      traceId,
    }, 500);
  }

  // For each chat, fetch the newest message concurrently
  const fetchLatestForChat = async (chat) => {
    try {
      // messages are assumed to have chatId and createdAt fields
      const msgRes = await messagesCol.find(
        { chatId: chat._id }, // adapt to your id field shape
        { sort: { createdAt: -1 }, limit: 1 }
      );
      const msgs = Array.isArray(msgRes?.data) ? msgRes.data : Object.values(msgRes?.data || {});
      const latest = msgs[0] || null;
      // do not populate old messages; attach only latestMessage
      return { ...chat, latestMessage: latest };
    } catch (err) {
      log.warn('Failed to fetch latest message for chat', { chatId: chat._id, err: err?.message || err });
      return { ...chat, latestMessage: null };
    }
  };

  let chatsWithLatest;
  try {
    const promises = chatsPage.map(fetchLatestForChat);
    chatsWithLatest = await Promise.all(promises);
  } catch (err) {
    log.error('Failed while fetching latest messages', { err: err?.message || err });
    return c.json({
      success: false,
      error: 'MESSAGE_LOOKUP_FAILED',
      message: 'Failed to retrieve latest messages.',
      timestamp,
      traceId,
    }, 500);
  }

  // Response metadata: pagination
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));

  return c.json({
    success: true,
    meta: {
      page,
      limit,
      totalCount,
      totalPages,
      returned: chatsWithLatest.length,
    },
    data: chatsWithLatest,
    timestamp,
    traceId,
  }, 200);
};
