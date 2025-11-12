import { getCollection } from '../../services/astra.js';

export async function getReviews(c) {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || 'trace-' + Date.now();

  const propertyId = c.req.query('property_id');
  if (!propertyId) {
    return c.json({ success: false, error: 'MISSING_PROPERTY_ID', message: 'property_id is required.', traceId, timestamp }, 400);
  }

  try {
    const reviewsCol = await getCollection('reviews');
    const result = await reviewsCol.find({
      property_id: { $eq: propertyId },
      status: { $eq: 'active' },
    });

    const reviews = Object.values(result?.data || {}).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return c.json({ success: true, reviews, count: reviews.length, traceId, timestamp });
  } catch (err) {
    console.error('❌ Review fetch failed:', err.message || err);
    return c.json({
      success: false,
      error: 'REVIEW_FETCH_FAILED',
      message: 'Unable to retrieve reviews.',
      traceId,
      timestamp,
    }, 500);
  }
}
