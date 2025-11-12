import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';
import { initR2 } from '../../services/r2.js';

/**
 * DELETE /banners/:id
 * Only admin or ceo can delete a banner and its image from R2.
 */
export const deleteBanner = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const bannerId = c.req.param('id');
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const user = token ? await checkToken(token) : null;

  if (!user || !['admin', 'ceo'].includes(user.role)) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only admin or ceo can delete banners.',
      timestamp,
      traceId,
    }, 403);
  }

  let bannersCol;
  try {
    bannersCol = await getCollection('banners');
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ DB connection error:', err.message || err);
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

  const imageUrl = banner.image;
  const key = imageUrl?.split('/').slice(-2).join('/') || null;

  try {
    await bannersCol.delete(bannerId);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Banner delete failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'DELETE_FAILED',
      message: 'Failed to delete banner.',
      timestamp,
      traceId,
    }, 500);
  }

  if (key) {
    try {
      const r2 = await initR2();
      await r2.deleteFile(key);
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('⚠️ R2 image delete failed:', err.message || err);
      }
    }
  }

  return c.json({
    success: true,
    message: 'Banner and image deleted successfully.',
    banner_id: bannerId,
    timestamp,
    traceId,
  }, 200);
};
