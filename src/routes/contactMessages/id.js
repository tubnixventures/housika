import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

/**
 * GET /contactMessages/:id
 * Returns a single contact message by ID.
 * Only accessible by customer care, admin, or ceo.
 */
export const getContactMessageById = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const id = c.req.param('id');

  if (!id) {
    return c.json({
      success: false,
      error: 'MISSING_ID',
      message: 'Message ID is required.',
      timestamp,
      traceId,
    }, 400);
  }

  const [actorResult, collectionResult] = await Promise.allSettled([
    token ? checkToken(token) : null,
    getCollection('contact_messages'),
  ]);

  const actor = actorResult.status === 'fulfilled' ? actorResult.value : null;
  const contactMessages = collectionResult.status === 'fulfilled' ? collectionResult.value : null;

  if (!actor || !['customer care', 'admin', 'ceo'].includes(actor.role)) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only customer care, admin, or ceo can view contact messages.',
      timestamp,
      traceId,
    }, 403);
  }

  if (!contactMessages) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ DB connection failed:', collectionResult.reason?.message || collectionResult.reason);
    }
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  let message;
  try {
    const result = await contactMessages.get(id);
    message = result?.data || null;
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Query failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'QUERY_FAILED',
      message: 'Failed to retrieve contact message.',
      timestamp,
      traceId,
    }, 500);
  }

  if (!message) {
    return c.json({
      success: false,
      error: 'NOT_FOUND',
      message: `No contact message found with ID ${id}.`,
      timestamp,
      traceId,
    }, 404);
  }

  return c.json({
    success: true,
    data: message,
    timestamp,
    traceId,
    actor_id: actor.userId,
  }, 200);
};
