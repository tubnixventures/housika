import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

const HIERARCHY = ['real estate company', 'landlord', 'dual', 'customer care', 'admin', 'ceo'];

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}
function isPhone(v) {
  return /^\+?\d{7,15}$/.test(String(v || '').trim());
}

/**
 * GET /users/:id
 * Also supports: /users/:id where :id may be an email or phone, and query params:
 *  - ?email=someone@x
 *  - ?phonenumber=+2547...
 *
 * Enforces hierarchy visibility: caller can only view users with roles at or below their rank.
 */
export const getUserById = async (c) => {
  const start = Date.now();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const token = c.req.header('Authorization')?.replace('Bearer ', '') || '';
  const timestamp = new Date().toISOString();

  if (!token) {
    return c.json({
      success: false,
      error: 'MISSING_TOKEN',
      message: 'Missing authentication token.',
      timestamp,
      traceId,
    }, 401);
  }

  const actor = await checkToken(token).catch((err) => {
    console.error('❌ Token validation failed:', err?.message || err);
    return null;
  });

  if (!actor?.role) {
    return c.json({
      success: false,
      error: 'INVALID_TOKEN',
      message: 'Invalid or expired token.',
      timestamp,
      traceId,
    }, 401);
  }

  // Determine lookup source: prefer explicit query params, then route param
  const q = Object.fromEntries(c.req.query());
  const routeParam = c.req.param('id');

  let lookup = null; // { type: 'id'|'email'|'phonenumber', value }

  if (q.email) lookup = { type: 'email', value: String(q.email).trim() };
  else if (q.phonenumber) lookup = { type: 'phonenumber', value: String(q.phonenumber).trim() };
  else if (routeParam) {
    const p = String(routeParam).trim();
    if (isEmail(p)) lookup = { type: 'email', value: p };
    else if (isPhone(p)) lookup = { type: 'phonenumber', value: p };
    else lookup = { type: 'id', value: p };
  }

  if (!lookup) {
    return c.json({
      success: false,
      error: 'INVALID_IDENTIFIER',
      message: 'Provide a user id in the route or an email/phonenumber as query or route param.',
      timestamp,
      traceId,
    }, 400);
  }

  let usersCollection;
  try {
    usersCollection = await getCollection('users');
    if (!usersCollection?.find || typeof usersCollection.find !== 'function') {
      throw new Error('Invalid Astra DB collection: missing .find() method.');
    }
  } catch (err) {
    console.error('❌ DB connection error:', err?.message || err);
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  // Build query depending on lookup type
  let query;
  if (lookup.type === 'id') {
    query = { _id: lookup.value };
  } else if (lookup.type === 'email') {
    query = { email: { $eq: lookup.value } };
  } else { // phonenumber
    query = { phonenumber: { $eq: lookup.value } };
  }

  try {
    const result = await usersCollection.find(query);
    const entries = Object.entries(result?.data || {});
    if (entries.length === 0) {
      return c.json({
        success: false,
        error: 'USER_NOT_FOUND',
        message: `No user found for ${lookup.type}: ${lookup.value}`,
        timestamp,
        traceId,
      }, 404);
    }

    // pick first matched document
    const [, targetUser] = entries[0];

    // Enforce hierarchy visibility: actor can only see roles at or below their rank
    const actorRank = HIERARCHY.indexOf(actor.role);
    const targetRank = HIERARCHY.indexOf(targetUser.role);

    if (actorRank === -1 || targetRank === -1) {
      return c.json({
        success: false,
        error: 'ROLE_UNKNOWN',
        message: 'One or both roles are unrecognized in hierarchy.',
        timestamp,
        traceId,
      }, 400);
    }

    // actor can view roles slice(0, actorRank + 1). If actor is 'ceo' they can see all.
    const visibleRoles = actor.role === 'ceo' ? HIERARCHY : HIERARCHY.slice(0, actorRank + 1);
    if (!visibleRoles.includes(targetUser.role)) {
      return c.json({
        success: false,
        error: 'FORBIDDEN',
        message: 'You are not permitted to view this user.',
        timestamp,
        traceId,
      }, 403);
    }

    return c.json({
      success: true,
      data: targetUser,
      timestamp,
      traceId,
      duration: `${Date.now() - start}ms`,
    });
  } catch (queryErr) {
    console.error('❌ Error fetching user:', queryErr?.message || queryErr);
    if (queryErr.response?.data) {
      console.error('📄 Astra error response:', JSON.stringify(queryErr.response.data, null, 2));
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to fetch user.',
      timestamp,
      traceId,
    }, 500);
  }
};
