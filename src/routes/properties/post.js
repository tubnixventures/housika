import { getCollection } from '../../services/astra.js';
import { checkToken, roleCheck } from '../../utils/auth.js';
import { verifyPayment } from '../../services/paystack.js';
import { initZeptoMail } from '../../services/zeptoEmail.js';
import { generatePropertySuccessEmail } from '../../utils/success.js';
import { generatePropertyFailureEmail } from '../../utils/failed.js';
import { uuid } from 'uuidv4';

export async function postProperty(c) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  let payload, email;

  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    payload = await checkToken(token);
    if (!payload) {
      return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid or missing token.', timestamp }, 401);
    }

    email = payload.email;
    const allowedRoles = ['landlord', 'admin', 'ceo', 'dual'];
    if (!roleCheck(payload, allowedRoles)) {
      return c.json({ success: false, error: 'FORBIDDEN', message: 'Insufficient role to create property.', timestamp }, 403);
    }

    const body = await c.req.json();
    const { title, description, price, location, rooms, payment_reference } = body;
    if (!title || !description || !price || !location || !payment_reference) {
      return c.json({ success: false, error: 'MISSING_FIELDS', message: 'All required fields must be provided.', timestamp }, 400);
    }
    if (rooms && !Array.isArray(rooms)) {
      return c.json({ success: false, error: 'INVALID_ROOMS', message: 'Rooms must be an array.', timestamp }, 400);
    }

    const isCEO = payload.role === 'ceo';

    let propertiesCol, roomsCol, paymentsCol;
    try {
      [propertiesCol, roomsCol, paymentsCol] = await Promise.all([
        getCollection('properties'),
        getCollection('rooms'),
        getCollection('payments'),
      ]);
    } catch (err) {
      await sendFailureEmail(email, payload.name, 'DB_CONNECTION_FAILED', 'Database connection failed.');
      return c.json({ success: false, error: 'DB_CONNECTION_FAILED', message: 'Database connection failed.', timestamp }, 503);
    }

    let paymentData = null;
    if (!isCEO) {
      try {
        const existing = await paymentsCol.find({ reference: { $eq: payment_reference } });
        const used = Object.values(existing?.data || {})[0];
        if (used?.status === 'used') {
          await sendFailureEmail(email, payload.name, 'PAYMENT_ALREADY_USED', 'Payment reference already used.');
          return c.json({ success: false, error: 'PAYMENT_ALREADY_USED', message: 'Payment reference already used.', timestamp }, 409);
        }

        const verified = await verifyPayment(payment_reference);
        paymentData = verified?.data;
        if (!paymentData || paymentData.status !== 'success') {
          await sendFailureEmail(email, payload.name, 'PAYMENT_VERIFICATION_FAILED', 'Payment verification failed.');
          return c.json({ success: false, error: 'PAYMENT_VERIFICATION_FAILED', message: 'Payment verification failed.', timestamp }, 402);
        }
      } catch (err) {
        await sendFailureEmail(email, payload.name, 'PAYMENT_VERIFICATION_ERROR', 'Unable to verify payment.');
        return c.json({ success: false, error: 'PAYMENT_VERIFICATION_ERROR', message: 'Unable to verify payment.', timestamp }, 500);
      }
    }

    const propertyId = uuid();
    const newProperty = {
      id: propertyId,
      title,
      description,
      price,
      location,
      landlordId: payload.userId,
      createdAt: timestamp,
      status: 'available',
    };

    try {
      await propertiesCol.post(newProperty);
    } catch (err) {
      await sendFailureEmail(email, payload.name, 'PROPERTY_INSERT_FAILED', 'Failed to create property.');
      return c.json({ success: false, error: 'PROPERTY_INSERT_FAILED', message: 'Failed to create property.', timestamp }, 500);
    }

    let roomsCreated = 0;
    try {
      const roomOps = (rooms || []).map((room, index) => {
        const { name, size, ensuite, amenities } = room;
        if (!name || !size) {
          throw new Error(`Room ${index + 1} missing required fields (name, size).`);
        }
        return roomsCol.post({
          room_id: uuid(),
          propertyId,
          name,
          size,
          ensuite: Boolean(ensuite),
          amenities: Array.isArray(amenities) ? amenities : [],
          createdAt: timestamp,
        });
      });

      const results = await Promise.all(roomOps);
      roomsCreated = results.length;
    } catch (err) {
      await sendFailureEmail(email, payload.name, 'ROOM_INSERT_FAILED', err.message || 'Failed to create rooms.');
      return c.json({ success: false, error: 'ROOM_INSERT_FAILED', message: err.message || 'Failed to create rooms.', timestamp }, 500);
    }

    if (!isCEO && paymentData) {
      try {
        await paymentsCol.post({
          reference: payment_reference,
          status: 'used',
          verified_at: timestamp,
          amount: paymentData.amount,
          currency: paymentData.currency,
          email: paymentData.customer?.email,
          metadata: paymentData.metadata || {},
          linked_property_id: propertyId,
        });
      } catch (err) {
        console.warn('⚠️ Failed to record payment usage:', err.message || err);
      }
    }

    await sendSuccessEmail(email, payload.name, title, roomsCreated);

    const duration = Date.now() - startTime;
    console.log(`✅ Property created in ${duration}ms`);
    return c.json({
      success: true,
      message: 'Property and rooms created successfully.',
      propertyId,
      roomsCreated,
      timestamp,
      durationMs: duration,
    }, 201);
  } catch (err) {
    await sendFailureEmail(email, payload?.name, 'UNEXPECTED_ERROR', err.message || 'Failed to create property.');
    return c.json({
      success: false,
      error: 'UNEXPECTED_ERROR',
      message: err.message || 'Failed to create property.',
      timestamp: new Date().toISOString(),
    }, 500);
  }
}

// 📧 Email helpers
async function sendSuccessEmail(to, name, propertyTitle, roomsCreated) {
  try {
    const zepto = await initZeptoMail();
    const htmlbody = generatePropertySuccessEmail({ name, propertyTitle, roomsCreated });
    await zepto.sendCustomerCareReply({
      to,
      subject: `✅ Property Created – ${propertyTitle}`,
      htmlbody,
      recipientName: name || 'User',
    });
  } catch (err) {
    console.warn('⚠️ Success email failed:', err.message || err);
  }
}

async function sendFailureEmail(to, name, errorCode, errorMessage) {
  try {
    const zepto = await initZeptoMail();
    const htmlbody = generatePropertyFailureEmail({ name, errorCode, errorMessage });
    await zepto.sendCustomerCareReply({
      to,
      subject: `❌ Property Creation Failed – ${errorCode}`,
      htmlbody,
      recipientName: name || 'User',
    });
  } catch (err) {
    console.warn('⚠️ Failure email failed:', err.message || err);
  }
}
