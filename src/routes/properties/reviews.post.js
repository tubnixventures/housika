import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';
import { uuid } from 'uuidv4';

export async function postReview(c) {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || uuid();

  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    const user = await checkToken(token);

    if (!user) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Missing or invalid token.', traceId, timestamp }, 401);
    }

    const body = await c.req.json();
    const { property_id, rating, title, comment, is_anonymous } = body;

    if (!property_id || !rating || !title || !comment) {
      return c.json({ success: false, error: 'MISSING_FIELDS', message: 'All fields are required.', traceId, timestamp }, 400);
    }

    const reviewsCol = await getCollection('reviews');

    const review = {
      review_id: uuid(),
      property_id,
      tenant_id: user.userId,
      tenant_email: user.email,
      tenant_name: user.name || 'Anonymous',
      is_anonymous: Boolean(is_anonymous),
      rating: Number(rating),
      title,
      comment,
      created_at: timestamp,
      updated_at: null,
      status: 'active',
      audit_ip: c.req.header('x-forwarded-for') || '',
      audit_useragent: c.req.header('user-agent') || '',
      audit_traceid: traceId,
    };

    await reviewsCol.post(review);

    return c.json({ success: true, review }, 201);
  } catch (err) {
    console.error('❌ Review creation failed:', err.message || err);
    return c.json({
      success: false,
      error: 'REVIEW_CREATION_FAILED',
      message: 'An error occurred while submitting your review.',
      traceId,
      timestamp,
    }, 500);
  }
}
