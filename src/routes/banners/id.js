import { getCollection } from '../../services/astra.js';

/**
 * GET /banners/:id
 * Returns a single banner by its document id (_id) or banner_id.
 * Public endpoint.
 */
export const getBannerById = async (c) => {
  const timestamp = new Date().toISOString();
  const id = String(c.req.param('id') || '').trim();

  if (!id) {
    return c.json({
      success: false,
      error: 'INVALID_ID',
      message: 'Banner id is required.',
      timestamp,
    }, 400);
  }

  let bannersCol;
  try {
    bannersCol = await getCollection('banners');
  } catch (err) {
    console.error('❌ DB connection error:', err?.message || err);
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
    }, 503);
  }

  try {
    // Try to find by document _id first (exact match)
    let result = await bannersCol.find({ _id: { $eq: id } });
    let banner = Object.values(result?.data || {})[0];

    // If not found, try alternative key names (banner_id or id)
    if (!banner) {
      result = await bannersCol.find({ banner_id: { $eq: id } });
      banner = Object.values(result?.data || {})[0];
    }
    if (!banner) {
      result = await bannersCol.find({ id: { $eq: id } });
      banner = Object.values(result?.data || {})[0];
    }

    if (!banner) {
      return c.json({
        success: false,
        error: 'BANNER_NOT_FOUND',
        message: `No banner found with id "${id}".`,
        timestamp,
      }, 404);
    }

    return c.json({
      success: true,
      data: banner,
      timestamp,
    }, 200);
  } catch (err) {
    console.error(`❌ Banner query failed for id ${id}:`, err?.message || err);
    return c.json({
      success: false,
      error: 'QUERY_FAILED',
      message: 'Failed to retrieve banner.',
      timestamp,
    }, 500);
  }
};
