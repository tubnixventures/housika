import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

/**
 * POST /banners
 * Only users with role "admin" or "ceo" can create a banner.
 */
export const createBanner = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  const user = token ? await checkToken(token) : null;
  if (!user || !['admin', 'ceo'].includes(user.role)) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only admin or ceo can create banners.',
      timestamp,
      traceId,
    }, 403);
  }

  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
  } catch (err) {
    return c.json({
      success: false,
      error: 'INVALID_BODY',
      message: 'Request body must be valid JSON.',
      timestamp,
      traceId,
    }, 400);
  }

  const banner_id = `BNR-${crypto.randomUUID()}`;
  const banner = {
    banner_id,
    ...body,
    created_by: user.userId,
    created_role: user.role,
    created_at: timestamp,
  };

  try {
    const bannersCol = await getCollection('banners');
    await bannersCol.post(banner);

    return c.json({
      success: true,
      message: 'Banner created successfully.',
      banner_id,
      timestamp,
      traceId,
    }, 200);
  } catch (err) {
    console.error('❌ Banner insert failed:', err.message || err);
    if (err.response?.data) {
      console.error('📄 Astra error response:', JSON.stringify(err.response.data, null, 2));
    }
    return c.json({
      success: false,
      error: 'INSERT_FAILED',
      message: 'Failed to create banner.',
      timestamp,
      traceId,
    }, 500);
  }
};
