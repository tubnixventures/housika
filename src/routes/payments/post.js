// src/functions/payments/post.js
import { getCollection } from '../../services/astra.js';
import { initializePayment } from '../../services/paystack.js';
import { sendEmail } from '../../services/email.js'; // dedicated payment email service
import crypto from 'crypto';

/**
 * Helper: ensure we have a stable reference
 * Format: PAY-{timestamp}-{short-random}
 */
function makeReference(prefix = 'PAY') {
  const short = crypto.randomBytes(4).toString('hex');
  const ts = Date.now();
  return `${prefix}-${ts}-${short}`;
}

/**
 * POST /payments/initiate
 * - Accepts JSON body with { amount, phonenumber, email, reference? , ... }
 * - If reference absent, server generates it and passes to provider as reference
 * - After initializing with provider, sends the payment URL to the supplied email
 */
const post = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId =
    c.req.header('x-trace-id') ||
    (crypto.randomUUID ? crypto.randomUUID() : makeReference('TRACE'));

  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
  } catch (parseErr) {
    console.error('❌ Failed to parse payment request body:', parseErr.message || parseErr);
    return c.json(
      {
        success: false,
        error: 'INVALID_BODY',
        message: 'Request body must be valid JSON.',
        timestamp,
        traceId,
      },
      400
    );
  }

  // Basic server-side validation
  const amount = Number(body.amount);
  const phonenumber = String(body.phonenumber || '').trim();
  const email = String(body.email || '').trim();
  if (!amount || Number.isNaN(amount) || amount <= 0) {
    return c.json(
      {
        success: false,
        error: 'INVALID_AMOUNT',
        message: 'Amount must be a positive number.',
        timestamp,
        traceId,
      },
      400
    );
  }
  if (!phonenumber || phonenumber.length < 6) {
    return c.json(
      {
        success: false,
        error: 'INVALID_PHONE',
        message: 'Phone number is required.',
        timestamp,
        traceId,
      },
      400
    );
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json(
      {
        success: false,
        error: 'INVALID_EMAIL',
        message: 'A valid payee email is required so we can send the payment link.',
        timestamp,
        traceId,
      },
      400
    );
  }

  // Ensure a server-authoritative reference exists
  const reference =
    body.reference && String(body.reference).trim()
      ? String(body.reference).trim()
      : makeReference('PAY');

  // Build payload for payment provider
  const providerPayload = {
    ...body,
    amount,
    phonenumber,
    email,
    reference,
  };

  try {
    // Initialize payment with provider
    const providerResult = await initializePayment(providerPayload);

    // Extract payment URL from provider response
    const paymentUrl =
      providerResult?.data?.authorization_url ||
      providerResult?.data?.payment_url ||
      providerResult?.authorization_url ||
      null;

    if (!paymentUrl) {
      console.warn('⚠️ Provider did not return payment URL', providerResult);
    }

    // Persist audit record
    try {
      const paymentsCol = await getCollection('payments');
      const record = {
        reference,
        amount,
        phonenumber,
        email,
        provider_response: providerResult,
        status: 'INITIATED',
        traceId,
        created_at: timestamp,
      };
      await paymentsCol.create(record).catch((e) => {
        console.warn('⚠️ Failed to persist payment record (non-fatal):', e.message || e);
      });
    } catch (persistErr) {
      console.warn('⚠️ Persist attempt failed:', persistErr.message || persistErr);
    }

    // Send payment URL email
    let emailSendResult = null;
    try {
      if (paymentUrl) {
        await sendEmail({
          to: email,
          reference,
          amount,
          paymentUrl,
          recipientName: body.name || 'User',
        });
        emailSendResult = { success: true };
      } else {
        emailSendResult = { success: false, error: 'NO_PAYMENT_URL' };
      }
    } catch (emailErr) {
      console.error('❌ Failed to send payment URL email:', emailErr.message || emailErr);
      emailSendResult = {
        success: false,
        error: emailErr.message || 'EMAIL_FAILED',
      };
    }

    // Successful initiation response
    return c.json({
      success: true,
      timestamp,
      traceId,
      reference,
      data: providerResult,
      email: emailSendResult,
    });
  } catch (err) {
    console.error('❌ Payment init error:', err.message || err);
    return c.json(
      {
        success: false,
        error: 'PAYMENT_INIT_FAILED',
        message: err.message || 'Failed to initialize payment.',
        timestamp,
        traceId,
      },
      500
    );
  }
};

export default post;
