import { getCollection } from '../../services/astra.js';
import { initializePayment } from '../../services/paystack.js';

const post = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();

  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
  } catch (parseErr) {
    console.error('❌ Failed to parse payment request body:', parseErr.message || parseErr);
    return c.json({
      success: false,
      error: 'INVALID_BODY',
      message: 'Request body must be valid JSON.',
      timestamp,
      traceId,
    }, 400);
  }

  // 🧼 Strip reference if present to let Paystack auto-generate
  const { reference, ...cleanBody } = body;

  try {
    const result = await initializePayment(cleanBody);
    return c.json({
      success: true,
      data: result,
      timestamp,
      traceId,
    });
  } catch (err) {
    console.error('❌ Payment init error:', err.message || err);
    return c.json({
      success: false,
      error: 'PAYMENT_INIT_FAILED',
      message: err.message || 'Failed to initialize payment.',
      timestamp,
      traceId,
    }, 500);
  }
};

export default post;
