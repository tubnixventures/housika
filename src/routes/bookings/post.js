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
  } catch {
    return c.json({
      success: false,
      error: 'INVALID_BODY',
      message: 'Request body must be valid JSON.',
      traceId,
      timestamp,
    }, 400);
  }

  const { room_id: roomId, payment_reference } = body;
  if (!roomId || !payment_reference) {
    return c.json({
      success: false,
      error: 'MISSING_FIELDS',
      message: 'Both room_id and payment_reference are required.',
      traceId,
      timestamp,
    }, 400);
  }

  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const userPayload = token ? await checkToken(token) : null;
  const isUser = !!userPayload;
  const isCEO = userPayload?.role === 'ceo';

  try {
    // Step 1: Load all collections in parallel
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

    // Step 2: Validate and verify payment if not CEO
    let paymentData = null;
    if (!isCEO) {
      const existing = await paymentsCol.find({ reference: { $eq: payment_reference } });
      const used = Object.values(existing?.data || {})[0];
      if (used?.status === 'used') {
        return c.json({
          success: false,
          error: 'PAYMENT_USED',
          message: 'This payment reference has already been used.',
          traceId,
          timestamp,
        }, 409);
      }

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

    // Step 3: Fetch room, property, landlord
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

    // Step 4: Construct booking object
    const receiptId = uuid();
    const booking = {
      booking_id: uuid(),
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
    };

    let tenantEmail = '', tenantName = '';
    if (isUser) {
      Object.assign(booking, {
        tenant_id: userPayload.userId,
        tenant_email: userPayload.email,
        tenant_role: userPayload.role,
      });
      tenantEmail = userPayload.email;
      tenantName = userPayload.name || 'Tenant';
    } else {
      const { full_name, phone_number, national_id, from, email } = body;
      if (!full_name || !phone_number || !national_id || !from || !email) {
        return c.json({
          success: false,
          error: 'MISSING_GUEST_FIELDS',
          message: 'Guest details are incomplete.',
          traceId,
          timestamp,
        }, 400);
      }
      booking.guest = { full_name, phone_number, national_id, from };
      tenantEmail = email;
      tenantName = full_name;
    }

    // Step 5: Generate receipt (QR + PDF) in parallel
    const verifyUrl = `https://housika.co.ke/verify-receipt/${receiptId}`;
    const [qrDataUrl, pdfBuffer] = await Promise.all([
      QRCode.toDataURL(verifyUrl),
      htmlToPdfBuffer(`...`), // Replace with actual HTML template
    ]);

    // Step 6: Upload receipt to R2
    const r2 = initR2();
    const receiptKey = `receipts/${receiptId}.pdf`;
    await r2.uploadFile(receiptKey, pdfBuffer, 'application/pdf');
    booking.receipt_url = r2.generatePublicUrl(receiptKey);
    booking.receipt_sent = true;

    // Step 7: Persist booking and update state
    await Promise.all([
      roomsCol.patch(room._id, { status: 'inactive' }),
      propertiesCol.patch(property._id, { unit_available: (property.unit_available || 1) - 1 }),
      bookingsCol.post(booking),
      !isCEO && paymentData && paymentsCol.post({
        reference: payment_reference,
        status: 'used',
        verified_at: timestamp,
        amount: paymentData.amount,
        currency: paymentData.currency,
        email: paymentData.customer?.email,
        metadata: paymentData.metadata || {},
      }),
    ].filter(Boolean));

    // Step 8: Fire-and-forget email dispatch
    (async () => {
      try {
        const zepto = initZeptoMail(c.env);
        await Promise.allSettled([
          zepto.sendCustomerCareReply({
            to: tenantEmail,
            subject: `Booking Confirmation – ${property.title}`,
            htmlbody: `<p>Dear ${tenantName}, your booking has been confirmed. <a href="${booking.receipt_url}">Download Receipt</a></p>`,
            recipientName: tenantName,
          }),
          zepto.sendCustomerCareReply({
            to: landlord.email,
            subject: `New Booking – ${property.title}`,
            htmlbody: `<p>Dear ${landlord.full_name || 'Landlord'}, a new booking has been made. Booking ID: ${booking.booking_id}</p>`,
            recipientName: landlord.full_name || 'Landlord',
          }),
        ]);
      } catch (err) {
        console.warn('⚠️ Email dispatch failed:', err.message || err);
      }
    })();

    console.log(`✅ Booking completed in ${Date.now() - startTime}ms`);
    return c.json({ success: true, booking });
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
