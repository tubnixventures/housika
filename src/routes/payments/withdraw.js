import { withdrawFunds } from '../../services/paystack.js';
import { checkToken } from '../../utils/auth.js';
import crypto from 'crypto';

const withdraw = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const idempotencyKey = c.req.header('Idempotency-Key') || null;

  // Auth
  const rawToken = c.req.header('Authorization')?.replace('Bearer ', '');
  const user = rawToken ? await checkToken(rawToken) : null;
  if (!user || user.role !== 'ceo') {
    return c.json({ success: false, error: 'FORBIDDEN', message: 'Only CEO can withdraw funds.', traceId, timestamp }, 403);
  }

  // Parse body
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'INVALID_BODY', message: 'Request body must be valid JSON.', traceId, timestamp }, 400);
  }

  // Validate
  const amount = Number(body.amount);
  const bank_code = String(body.bank_code || '').trim();
  const account_number = String(body.account_number || '').trim();
  const narration = body.narration?.trim() || undefined;
  const currency = (body.currency || 'KES').toUpperCase();

  if (!amount || Number.isNaN(amount) || amount <= 0) {
    return c.json({ success: false, error: 'INVALID_AMOUNT', message: 'Amount must be a positive number.', traceId, timestamp }, 400);
  }
  if (!bank_code || !account_number) {
    return c.json({ success: false, error: 'MISSING_FIELDS', message: 'Bank code and account number are required.', traceId, timestamp }, 400);
  }

  // Build provider payload
  const payload = {
    amount,
    bank_code,
    account_number,
    narration,
    currency, // default KES
    initiated_by: user.userId,
    traceId,
  };

  try {
    const result = await withdrawFunds(payload, { idempotencyKey });
    return c.json({ success: true, data: result, traceId, timestamp });
  } catch (err) {
    console.error('❌ Withdrawal error:', err.message || err, { traceId });
    return c.json(
      {
        success: false,
        error: 'WITHDRAWAL_FAILED',
        message: err.message || 'Failed to withdraw funds.',
        traceId,
        timestamp,
      },
      500
    );
  }
};

export default withdraw;
