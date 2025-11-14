// src/functions/properties/post.js
import { getCollection } from '../../services/astra.js';
import { checkToken, roleCheck } from '../../utils/auth.js';
import { verifyPayment } from '../../services/paystack.js';
import { initZeptoMail } from '../../services/zeptoEmail.js';
import { generatePropertySuccessEmail } from '../../utils/success.js';
import { generatePropertyFailureEmail } from '../../utils/failed.js';
import { uuid } from 'uuidv4';

function isValidUrl(v) {
  if (!v || typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return ['http:', 'https:'].includes(u.protocol);
  } catch {
    return false;
  }
}

export async function postProperty(c) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  let payload, email;

  try {
    // Auth + role
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    payload = await checkToken(token);
    if (!payload) {
      return c.json(
        { success: false, error: 'UNAUTHORIZED', message: 'Invalid or missing token.', timestamp },
        401
      );
    }

    email = payload.email;
    const allowedRoles = ['landlord', 'admin', 'ceo', 'dual'];
    if (!roleCheck(payload, allowedRoles)) {
      return c.json(
        { success: false, error: 'FORBIDDEN', message: 'Insufficient role to create property.', timestamp },
        403
      );
    }

    const body = await c.req.json();
    const {
      title,
      description,
      price,
      location,
      rooms,
      payment_reference,
      video,
      video_thumbnail,
    } = body;

    // Required fields
    if (!title || !description || !price || !location || !payment_reference) {
      return c.json(
        { success: false, error: 'MISSING_FIELDS', message: 'All required fields must be provided.', timestamp },
        400
      );
    }

    // Optional video fields validation
    if (video && !isValidUrl(video)) {
      return c.json(
        { success: false, error: 'INVALID_VIDEO_URL', message: 'Video must be a valid public URL.', timestamp },
        400
      );
    }
    if (video_thumbnail && !isValidUrl(video_thumbnail)) {
      return c.json(
        { success: false, error: 'INVALID_VIDEO_THUMBNAIL', message: 'Video thumbnail must be a valid public URL.', timestamp },
        400
      );
    }

    // Rooms array validation (optional)
    if (rooms && !Array.isArray(rooms)) {
      return c.json(
        { success: false, error: 'INVALID_ROOMS', message: 'Rooms must be an array.', timestamp },
        400
      );
    }

    const isCEO = payload.role === 'ceo';

    // Collections
    let propertiesCol, roomsCol, paymentsCol;
    try {
      [propertiesCol, roomsCol, paymentsCol] = await Promise.all([
        getCollection('properties'),
        getCollection('rooms'),
        getCollection('payments'),
      ]);
    } catch (err) {
      await sendFailureEmail(email, payload.name, 'DB_CONNECTION_FAILED', 'Database connection failed.');
      return c.json(
        { success: false, error: 'DB_CONNECTION_FAILED', message: 'Database connection failed.', timestamp },
        503
      );
    }

    // Payment verification: allow valid payments even if not present in DB.
    let paymentData = null;
    if (!isCEO) {
      // Block only if a local record explicitly marks the reference as used.
      try {
        const existing = await paymentsCol.find({ reference: { $eq: payment_reference } });
        const existingRow = Object.values(existing?.data || {})[0];
        if (existingRow?.status === 'used') {
          await sendFailureEmail(email, payload.name, 'PAYMENT_ALREADY_USED', 'Payment reference already used.');
          return c.json(
            { success: false, error: 'PAYMENT_ALREADY_USED', message: 'Payment reference already used.', timestamp },
            409
          );
        }
      } catch (dbErr) {
        // Non-fatal; proceed to provider verification
        console.warn('⚠️ Payment DB check failed (non-fatal):', dbErr?.message || dbErr);
      }

      // Provider verification (authoritative)
      try {
        const verified = await verifyPayment(payment_reference);
        paymentData = verified?.data;
        if (!paymentData || paymentData.status !== 'success') {
          await sendFailureEmail(email, payload.name, 'PAYMENT_VERIFICATION_FAILED', 'Payment verification failed.');
          return c.json(
            { success: false, error: 'PAYMENT_VERIFICATION_FAILED', message: 'Payment verification failed.', timestamp },
            402
          );
        }
      } catch (err) {
        await sendFailureEmail(email, payload.name, 'PAYMENT_VERIFICATION_ERROR', 'Unable to verify payment.');
        return c.json(
          { success: false, error: 'PAYMENT_VERIFICATION_ERROR', message: 'Unable to verify payment.', timestamp },
          500
        );
      }
    }

    // Create property using "active" as primary distinguishing characteristic
    const propertyId = uuid();
    const unitAvailable = Array.isArray(rooms) ? rooms.length : 0;
    const newProperty = {
      property_id: propertyId,
      active: true, // primary status flag
      title,
      description,
      price,
      location,
      landlord_id: payload.userId,
      created_at: timestamp,
      status: 'available',
      unit_available: unitAvailable,
      // optional media
      video: video || null,
      video_thumbnail: video_thumbnail || null,
    };

    try {
      await propertiesCol.post(newProperty);
    } catch (err) {
      await sendFailureEmail(email, payload.name, 'PROPERTY_INSERT_FAILED', 'Failed to create property.');
      return c.json(
        { success: false, error: 'PROPERTY_INSERT_FAILED', message: 'Failed to create property.', timestamp },
        500
      );
    }

    // Create rooms (active by default)
    let roomsCreated = 0;
    if (Array.isArray(rooms) && rooms.length) {
      try {
        const ops = rooms.map((room, index) => {
          const { name, size, ensuite, amenities } = room;
          if (!name || !size) {
            throw new Error(`Room ${index + 1} missing required fields (name, size).`);
          }
          return roomsCol.post({
            room_id: uuid(),
            property_id: propertyId,
            active: true,
            name,
            size,
            ensuite: Boolean(encuiteOrBoolean(ensuite)),
            amenities: Array.isArray(amenities) ? amenities : [],
            created_at: timestamp,
            status: 'available',
          });
        });

        const results = await Promise.all(ops);
        roomsCreated = results.length;
      } catch (err) {
        await sendFailureEmail(email, payload.name, 'ROOM_INSERT_FAILED', err.message || 'Failed to create rooms.');
        return c.json(
          { success: false, error: 'ROOM_INSERT_FAILED', message: err.message || 'Failed to create rooms.', timestamp },
          500
        );
      }
    }

    // Record payment usage (optional) — only when verified with provider
    if (!isCEO && paymentData) {
      try {
        await paymentsCol.post({
          reference: payment_reference,
          status: 'used',
          active: false, // used payments are not active
          verified_at: timestamp,
          amount: paymentData.amount,
          currency: paymentData.currency,
          email: paymentData.customer?.email || email,
          metadata: paymentData.metadata || {},
          linked_property_id: propertyId,
        });
      } catch (err) {
        console.warn('⚠️ Failed to record payment usage:', err.message || err);
      }
    }

    // Success email
    await sendSuccessEmail(email, payload.name, title, roomsCreated, !!video);

    const duration = Date.now() - startTime;
    console.log(`✅ Property created in ${duration}ms`);
    return c.json(
      {
        success: true,
        message: 'Property and rooms created successfully.',
        propertyId,
        roomsCreated,
        active: true,
        timestamp,
        durationMs: duration,
      },
      201
    );
  } catch (err) {
    await sendFailureEmail(email, payload?.name, 'UNEXPECTED_ERROR', err.message || 'Failed to create property.');
    return c.json(
      {
        success: false,
        error: 'UNEXPECTED_ERROR',
        message: err.message || 'Failed to create property.',
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
}

/* ----------------------- Helpers ----------------------- */

function encuiteOrBoolean(val) {
  // defensive boolean normalization for "ensuite"
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const v = val.trim().toLowerCase();
    return v === 'true' || v === 'yes' || v === '1';
  }
  if (typeof val === 'number') return val === 1;
  return false;
}

// 📧 Email helpers (unchanged except for recipient name default)
async function sendSuccessEmail(to, name, propertyTitle, roomsCreated, hasVideo = false) {
  try {
    const zepto = await initZeptoMail();
    const htmlbody = generatePropertySuccessEmail({ name, propertyTitle, roomsCreated, hasVideo });
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
