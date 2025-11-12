import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';
import { initR2 } from '../../services/r2.js';

/**
 * PUT /banners/:id
 * Only admin or ceo can update a banner.
 * Deletes old image from R2 if replaced.
 */
export const updateBanner = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const bannerId = c.req.param('id');
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  // --- 🔄 Parallel warmup ---
  const [userResult, collectionResult] = await Promise.allSettled([
    token ? checkToken(token) : null,
    getCollection('banners'),
  ]);

  const user = userResult.status === 'fulfilled' ? userResult.value : null;
  const bannersCol = collectionResult.status === 'fulfilled' ? collectionResult.value : null;

  if (!user || !['admin', 'ceo'].includes(user.role)) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only admin or ceo can update banners.',
      timestamp,
      traceId,
    }, 403);
  }

  if (!bannersCol) {
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

  let banner;
  try {
    const result = await bannersCol.find({ _id: { $eq: bannerId } });
    banner = Object.values(result?.data || {})[0];
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Banner query failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'DB_QUERY_FAILED',
      message: 'Failed to retrieve banner.',
      timestamp,
      traceId,
    }, 500);
  }

  if (!banner) {
    return c.json({
      success: false,
      error: 'BANNER_NOT_FOUND',
      message: 'Banner not found.',
      timestamp,
      traceId,
    }, 404);
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

  const oldImageUrl = banner.image;
  const newImageUrl = body.image;

  const imageChanged = oldImageUrl && newImageUrl && oldImageUrl !== newImageUrl;

  // --- 🧹 Delete old image if replaced ---
  if (imageChanged) {
    const key = oldImageUrl.split('/').slice(-2).join('/');
    try {
      const r2 = await initR2();
      await r2.deleteFile(key);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`🧹 Deleted old image from R2: ${key}`);
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('⚠️ Failed to delete old image from R2:', err.message || err);
      }
    }
  }

  // --- ✏️ Patch banner ---
  try {
    await bannersCol.patch(bannerId, body);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`✏️ Updated banner document: ${bannerId}`);
    }
    return c.json({
      success: true,
      message: 'Banner updated successfully.',
      banner_id: bannerId,
      timestamp,
      traceId,
    }, 200);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Banner update failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'UPDATE_FAILED',
      message: 'Failed to update banner.',
      timestamp,
      traceId,
    }, 500);
  }
};
