// src/functions/bookings/post.js
import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { uuid } from 'uuidv4';
import { checkToken } from '../../utils/auth.js';
import { initZeptoMail } from '../../services/zeptoEmail.js';
import { initR2 } from '../../services/r2.js';
import { htmlToPdfBuffer } from '../../utils/pdf.js';
import { verifyPayment } from '../../services/paystack.js';
import QRCode from 'qrcode';

const bookings = async (c) => {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();

  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
  } catch {
    return c.json({
      success: false,
      error: 'INVALID_BODY',
      message: 'Request body must be valid JSON.',
      traceId,
      timestamp,
    }, 400);
  }

  const { room_id: roomId, payment_reference, email: bodyEmail } = body || {};
  if (!roomId || !payment_reference) {
    return c.json({
      success: false,
      error: 'MISSING_FIELDS',
      message: 'Both room_id and payment_reference are required.',
      traceId,
      timestamp,
    }, 400);
  }

  // Auth
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const userPayload = token ? await checkToken(token) : null;
  const isUser = !!userPayload;
  const isCEO = userPayload?.role === 'ceo';

  // Resolve email: prefer token email, otherwise use trimmed body email
  const resolvedEmail = String(userPayload?.email || (bodyEmail || '')).trim();
  if (!resolvedEmail) {
    return c.json({
      success: false,
      error: 'MISSING_EMAIL',
      message: 'An email address is required for sending the receipt.',
      traceId,
      timestamp,
    }, 400);
  }

  try {
    // Collections
    const [
      roomsCol,
      propertiesCol,
      usersCol,
      bookingsCol,
      paymentsCol,
    ] = await Promise.all([
      getCollection('rooms'),
      getCollection('properties'),
      getCollection('users'),
      getCollection('bookings'),
      getCollection('payments'),
    ]);

    // Payment verification (CEO bypass). Allow valid payments that don't exist in DB.
    let paymentData = null;
    if (!isCEO) {
      // Check local DB for "used" status only; absence in DB should NOT block.
      try {
        const existing = await paymentsCol.find({ reference: { $eq: payment_reference } });
        const existingRow = Object.values(existing?.data || {})[0];
        if (existingRow?.status === 'used') {
          return c.json({
            success: false,
            error: 'PAYMENT_USED',
            message: 'This payment reference has already been used.',
            traceId,
            timestamp,
          }, 409);
        }
      } catch (dbCheckErr) {
        // Non-fatal: proceed with provider verification even if DB check fails
        console.warn('⚠️ Payment DB check failed (non-fatal):', dbCheckErr?.message || dbCheckErr);
      }

      // Verify with provider (authoritative)
      try {
        const verified = await verifyPayment(payment_reference);
        paymentData = verified?.data;
        if (!paymentData || paymentData.status !== 'success') {
          return c.json({
            success: false,
            error: 'PAYMENT_FAILED',
            message: 'Payment verification was unsuccessful.',
            traceId,
            timestamp,
          }, 402);
        }
      } catch (err) {
        if (err.message?.includes('Transaction reference not found')) {
          return c.json({
            success: false,
            error: 'PAYMENT_REFERENCE_NOT_FOUND',
            message: 'Provided payment reference is invalid.',
            traceId,
            timestamp,
          }, 402);
        }
        throw err;
      }
    }

    // Fetch room and property
    const [roomDoc, propertyDoc] = await Promise.all([
      roomsCol.find({ room_id: { $eq: roomId } }),
      propertiesCol.find({ property_id: { $eq: roomId.split('-')[0] } }),
    ]);
    const room = Object.values(roomDoc?.data || {})[0];
    const property = Object.values(propertyDoc?.data || {})[0];
    if (!room || !property) {
      return c.json({
        success: false,
        error: 'ROOM_OR_PROPERTY_NOT_FOUND',
        message: 'Room or property could not be located.',
        traceId,
        timestamp,
      }, 404);
    }

    // Landlord
    const landlordDoc = await usersCol.find({ user_id: { $eq: property.landlord_id } });
    const landlord = Object.values(landlordDoc?.data || {})[0];
    if (!landlord) {
      return c.json({
        success: false,
        error: 'LANDLORD_NOT_FOUND',
        message: 'Associated landlord record is missing.',
        traceId,
        timestamp,
      }, 404);
    }

    // Build booking (use "active" as primary distinguishing characteristic)
    const receiptId = uuid();
    const booking = {
      booking_id: uuid(),
      active: true, // primary status flag
      receipt_id: receiptId,
      room_id: roomId,
      room_title: room.title,
      room_price: room.price,
      room_type: room.type,
      property_id: property.property_id,
      property_title: property.title,
      property_location: property.location,
      landlord_id: property.landlord_id,
      landlord_email: landlord.email,
      created_at: timestamp,
      category: 'standard',
      currency: 'KES',
      receipt_sent: false,
      audit_ip: c.req.header('x-forwarded-for') || '',
      audit_useragent: c.req.header('user-agent') || '',
      audit_traceid: traceId,
      payment_reference, // tie booking to payment
    };

    // Tenant info
    let tenantEmail = '';
    let tenantName = '';
    if (isUser) {
      Object.assign(booking, {
        tenant_id: userPayload.userId,
        tenant_email: userPayload.email,
        tenant_role: userPayload.role,
      });
      tenantEmail = bodyEmail || userPayload.email || resolvedEmail;
      tenantName = userPayload.name || body?.full_name || 'Tenant';
    } else {
      // Guest flow
      const { full_name, phone_number, national_id, from } = body;
      if (!full_name || !phone_number || !national_id || !from) {
        return c.json({
          success: false,
          error: 'MISSING_GUEST_FIELDS',
          message: 'Guest details are incomplete.',
          traceId,
          timestamp,
        }, 400);
      }
      booking.guest = { full_name, phone_number, national_id, from };
      tenantEmail = resolvedEmail;
      tenantName = full_name || 'Guest';
    }

    // Admin override for explicit tenant_id
    if (userPayload?.role && ['admin', 'ceo'].includes(userPayload.role) && body?.tenant_id) {
      booking.tenant_id = body.tenant_id;
    }

    // Generate receipt: QR + PDF
    const verifyUrl = `https://housika.co.ke/verify-receipt/${receiptId}`;
    const [qrDataUrl, pdfBuffer] = await Promise.all([
      QRCode.toDataURL(verifyUrl),
      htmlToPdfBuffer(`<!doctype html><html><body><h1>Receipt</h1><p>Booking receipt for ${tenantName}</p><img src="${qrDataUrl}" /></body></html>`),
    ]);

    // Upload receipt to R2
    const r2 = initR2();
    const receiptKey = `receipts/${receiptId}.pdf`;
    await r2.uploadFile(receiptKey, pdfBuffer, 'application/pdf');
    booking.receipt_url = r2.generatePublicUrl(receiptKey);
    booking.receipt_sent = true;

    // Persist booking and update state
    const nextUnits = Math.max(0, (property.unit_available || 1) - 1);
    await Promise.all([
      roomsCol.patch(room._id, { status: 'inactive', active: false }),
      propertiesCol.patch(property._id, { unit_available: nextUnits, active: nextUnits > 0 }),
      bookingsCol.post(booking),
      // Only mark payment as used when we verified with provider; allow absence in DB.
      (!isCEO && paymentData) && paymentsCol.post({
        reference: payment_reference,
        status: 'used',
        active: false, // used payments are not active
        verified_at: timestamp,
        amount: paymentData.amount,
        currency: paymentData.currency,
        email: paymentData.customer?.email || resolvedEmail,
        metadata: paymentData.metadata || {},
        traceId,
      }),
    ].filter(Boolean));

    // Emails (fire-and-forget)
    (async () => {
      try {
        const zepto = await initZeptoMail(c.env);
        await Promise.allSettled([
          zepto.sendCustomerCareReply({
            to: tenantEmail,
            subject: `Booking Confirmation – ${property.title}`,
            htmlbody: `
              <html>
                <body>
                  <p>Dear ${tenantName}, your booking has been confirmed.</p>
                  <p><a href="${booking.receipt_url}">Download Receipt</a></p>
                </body>
              </html>
            `,
            recipientName: tenantName,
          }),
          zepto.sendCustomerCareReply({
            to: landlord.email,
            subject: `New Booking – ${property.title}`,
            htmlbody: `
              <html>
                <body>
                  <p>Dear ${landlord.full_name || 'Landlord'}, a new booking has been made.</p>
                  <p>Booking ID: ${booking.booking_id}</p>
                </body>
              </html>
            `,
            recipientName: landlord.full_name || 'Landlord',
          }),
        ]);
      } catch (err) {
        console.warn('⚠️ Email dispatch failed:', err.message || err);
      }
    })();

    console.log(`✅ Booking completed in ${Date.now() - startTime}ms`);
    return c.json({ success: true, booking, traceId, timestamp });
  } catch (err) {
    console.error('❌ Booking creation failed:', err);
    return c.json({
      success: false,
      error: 'BOOKING_CREATION_FAILED',
      message: 'An unexpected error occurred while processing your booking.',
      traceId,
      timestamp,
    }, 500);
  }
};

export default bookings;
