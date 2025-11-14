import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';

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
 * GET /chats/:id
 * - Validates chatId
 * - Applies tenant/participant scoping (reads from c.state.user or x-user-id)
 * - Supports pagination (limit, page or cursor), sorting (createdAt), and projection
 * - Returns messages for the chat ordered by createdAt asc (older -> newer) by default
 */
export const getMessagesForChat = async (c) => {
  const timestamp = nowIso();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const log = makeLogger(traceId);

  // Validate route param
  const chatId = c.req.param('id');
  if (!chatId || typeof chatId !== 'string') {
    log.warn('Invalid chat id', { chatId });
    return c.json({
      success: false,
      error: 'INVALID_CHAT_ID',
      message: 'Chat ID must be a valid string.',
      timestamp,
      traceId,
    }, 400);
  }

  // Auth / tenant inference - replace with your real auth middleware
  const authUser = c.state?.user || null;
  const authUserId = authUser?.id || c.req.header('x-user-id') || null;
  const tenantId = authUser?.tenantId || c.req.header('x-tenant-id') || null;

  // Query params: limit/page or cursor, and optional order
  const q = c.req.query || {};
  let limit = Math.min(Math.max(parseInt(q.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const cursor = q.cursor || null; // optional cursor for stable pagination
  const order = (q.order === 'desc' ? -1 : 1); // 1 => asc, -1 => desc
  const sortOption = { createdAt: order };

  // Build DB filter with tenant and chatId; enforce participant check if possible
  const filter = { chatId };
  if (tenantId) filter.tenantId = tenantId;
  if (q.participantId) filter['participants.userId'] = q.participantId;
  // Optionally: restrict by authenticated user being a participant
  if (authUserId && !q.participantId) {
    filter['participants.userId'] = authUserId;
  }

  // Defensive: get collection
  let messagesCol;
  try {
    messagesCol = await getCollection(MESSAGE_COLLECTION);
    if (!messagesCol) throw new Error('messages collection unavailable');
  } catch (err) {
    log.error('DB connection failed', { err: err?.message || err });
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  // Prepare find options: projection, sort, limit, skip or cursor handling
  const projection = { chatId: 1, body: 1, type: 1, createdAt: 1, createdBy: 1, metadata: 1 };
  const skip = cursor ? 0 : (page - 1) * limit; // cursor handling would override skip
  let messages = [];
  let total = null;

  try {
    // If the getCollection API supports cursor-based paging, prefer that path.
    // Here we attempt a generic call that works with common SDK shapes: find(filter, options)
    const findOptions = { projection, sort: sortOption, limit, skip };

    // If cursor provided, translate to a createdAt cursor filter for stable paging
    if (cursor) {
      // cursor expected to be an ISO createdAt string or base64-encoded marker
      const cursorDate = new Date(cursor);
      if (!isNaN(cursorDate)) {
        // For asc: fetch createdAt > cursor ; for desc: createdAt < cursor
        filter.createdAt = order === 1 ? { $gt: cursorDate.toISOString() } : { $lt: cursorDate.toISOString() };
      } else {
        log.warn('Invalid cursor ignored', { cursor });
      }
      // do not set skip when using cursor
      delete findOptions.skip;
    }

    const result = await messagesCol.find(filter, findOptions);
    // normalize result shape from getCollection: support { data: [...] } or array directly
    messages = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : Object.values(result?.data || {});

    // Try to read total count if available from driver (optional)
    if (typeof result?.total === 'number') total = result.total;
  } catch (err) {
    log.error('Message query failed', { err: err?.message || err, filter, limit, page });
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to retrieve chat messages.',
      timestamp,
      traceId,
    }, 500);
  }

  // Build nextCursor if using cursor pagination
  let nextCursor = null;
  if (messages.length === limit) {
    const last = messages[messages.length - 1];
    nextCursor = last?.createdAt || null;
  }

  // Response
  return c.json({
    success: true,
    chatId,
    meta: {
      returned: messages.length,
      limit,
      page,
      nextCursor,
      total, // may be null if driver didn't provide it
      order: order === 1 ? 'asc' : 'desc',
    },
    data: messages,
    timestamp,
    traceId,
  }, 200);
};
