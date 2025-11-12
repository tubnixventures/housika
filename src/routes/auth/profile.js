import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';
import { parse } from 'cookie';

const USERS_COLLECTION = 'users';

const profile = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();

  const cookieToken = parse(c.req.header('Cookie') || '').token;
  const authToken = c.req.header('Authorization')?.replace('Bearer ', '');
  const token = authToken || cookieToken;

  if (!token) {
    return c.json({
      success: false,
      error: 'MISSING_TOKEN',
      message: 'Missing authentication token.',
      timestamp,
      traceId,
    }, 401);
  }

  const decoded = await checkToken(token);
  if (!decoded?.userId) {
    return c.json({
      success: false,
      error: 'INVALID_TOKEN',
      message: 'Invalid or expired token.',
      timestamp,
      traceId,
    }, 401);
  }

  try {
    const users = await getCollection(USERS_COLLECTION);
    const userDoc = await users.findOne({ userId: decoded.userId });
    const data = userDoc?.data;

    if (!data) {
      return c.json({
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'User not found.',
        timestamp,
        traceId,
      }, 404);
    }

    const { password, ...safeUser } = data;

    return c.json({
      success: true,
      profile: safeUser,
      timestamp,
      traceId,
    });
  } catch (err) {
    console.error(`❌ PROFILE_FETCH_FAILED [${traceId}]:`, err.message || err);
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to fetch profile.',
      timestamp,
      traceId,
    }, 500);
  }
};

export default profile;
