import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

/**
 * GET /contactMessages
 * Returns all contact messages for authorized roles.
 * Only accessible by customer care, admin, or ceo.
 */
export const getContactMessages = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

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

  const emailFilter = c.req.query('email');
  const fromDate = c.req.query('from');
  const toDate = c.req.query('to');

  const query = {};
  if (emailFilter) query.email = { $eq: emailFilter };
  if (fromDate || toDate) {
    query.created_at = {};
    if (fromDate) query.created_at.$gte = fromDate;
    if (toDate) query.created_at.$lte = toDate;
  }

  let messages = [];
  try {
    const result = await contactMessages.find(query);
    messages = Object.values(result?.data || {});
    messages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Query failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'QUERY_FAILED',
      message: 'Failed to retrieve contact messages.',
      timestamp,
      traceId,
    }, 500);
  }

  return c.json({
    success: true,
    count: messages.length,
    data: messages,
    timestamp,
    traceId,
    actor_id: actor.userId,
  }, 200);
};
