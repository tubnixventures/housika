import { v4 as uuidv4 } from 'uuid';
import { getCollection } from '../../services/astra.js';
import { initZeptoMail } from '../../services/zeptoEmail.js';

export const postContactMessage = async (c) => {
  const start = Date.now();
  const incomingTrace = c.req.header('x-trace-id') || c.req.query?.()?.traceId;
  const traceId = (incomingTrace && String(incomingTrace)) || uuidv4();
  const timestamp = new Date().toISOString();

  // parse body
  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
  } catch {
    return c.json({
      success: false,
      error: 'INVALID_BODY',
      message: 'Request body must be valid JSON.',
      timestamp,
      traceId,
    }, 400);
  }

  const { name, email, message } = body;
  if (!name || !email || !message) {
    return c.json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'Name, email, and message are required.',
      timestamp,
      traceId,
    }, 400);
  }

  // audit metadata
  const audit = {
    ip: c.req.header('x-forwarded-for') || '',
    useragent: c.req.header('user-agent') || '',
    traceid: traceId,
  };

  // ensure we have an id to persist (and return) for robust frontend routing
  const generatedId = uuidv4();
  const messageRecord = {
    _id: generatedId, // prefer explicit _id so SDKs that expect ids will keep it
    name: String(name).trim(),
    email: String(email).trim(),
    message: String(message).trim(),
    created_at: timestamp,
    ...audit,
  };

  // open collection and mailer in parallel
  const [collectionResult, zeptoResult] = await Promise.allSettled([
    getCollection('contact_messages'),
    initZeptoMail(c.env),
  ]);

  const contactMessages = collectionResult.status === 'fulfilled' ? collectionResult.value : null;
  const zepto = zeptoResult.status === 'fulfilled' ? zeptoResult.value : null;

  if (!contactMessages) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ DB connection failed:', collectionResult.reason?.message || collectionResult.reason);
    }
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

  // attempt insert; handle common SDK shapes
  let result;
  try {
    if (typeof contactMessages.post === 'function') {
      result = await contactMessages.post(messageRecord);
    } else if (typeof contactMessages.create === 'function') {
      result = await contactMessages.create(messageRecord);
    } else if (typeof contactMessages.insert === 'function') {
      result = await contactMessages.insert(messageRecord);
    } else {
      if (typeof contactMessages.put === 'function') {
        await contactMessages.put(messageRecord._id, messageRecord);
        result = { documentId: messageRecord._id };
      } else {
        throw new Error('Unsupported collection driver (no known insert method)');
      }
    }
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('❌ Insert failed:', err.message || err);
    }
    return c.json({
      success: false,
      error: 'INSERT_FAILED',
      message: 'Unable to save your message.',
      timestamp,
      traceId,
    }, 500);
  }

  // normalize id returned by SDK
  const returnedId = result?.documentId || result?.insertedId || result?.id || result?._id || messageRecord._id || generatedId;

  // best-effort patch when SDK returns a different id
  if (returnedId && returnedId !== messageRecord._id) {
    try {
      if (typeof contactMessages.put === 'function') {
        const existing = await contactMessages.get?.(returnedId).catch(() => null);
        if (existing && !existing._id) {
          const patched = { ...existing, _id: returnedId };
          await contactMessages.put(returnedId, patched).catch(() => null);
        }
      }
    } catch {
      // ignore patch failures
    }
  }

  // send acknowledgement email (best-effort)
  if (zepto) {
    try {
      const subject = `Housika Customer Message Received – ${new Date().toLocaleDateString()}`;
      const htmlbody = generateCustomerCareEmail(messageRecord.name);
      await zepto.sendCustomerCareReply({
        to: messageRecord.email,
        subject,
        htmlbody,
        recipientName: messageRecord.name,
      });
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('⚠️ Email dispatch failed:', err.message || err);
      }
    }
  }

  // return stable response including canonical id and minimal metadata
  return c.json({
    success: true,
    message: '✅ Message received successfully. Our Customer Care Desk will respond shortly.',
    id: returnedId || generatedId,
    data: {
      _id: returnedId || generatedId,
      name: messageRecord.name,
      email: messageRecord.email,
      created_at: messageRecord.created_at,
    },
    timestamp,
    traceId,
    duration: `${Date.now() - start}ms`,
  });
};

function generateCustomerCareEmail(name) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { margin: 0; padding: 0; font-family: 'Segoe UI', Roboto, Arial, sans-serif; background-color: #f4f4f4; }
    .container { max-width: 700px; margin: auto; background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.05); }
    h2 { color: #b31b1b; margin-bottom: 10px; }
    p { color: #333333; font-size: 16px; line-height: 1.6; }
    .footer { margin-top: 40px; font-size: 13px; color: #777777; text-align: center; }
    .footer a { color: #b31b1b; text-decoration: none; margin: 0 10px; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Housika Properties – Customer Care Desk</h2>
    <p>Dear ${name},</p>
    <p>
      Thank you for contacting Housika Properties. Your message has been received and assigned to a support officer.
      We aim to respond within 24 hours. For urgent matters, reach us via WhatsApp at <strong>+254785103445</strong>.
    </p>
    <p style="font-size: 14px; color: #555;">
      This message is logged for audit purposes. Please do not share sensitive data via email.
    </p>
    <div class="footer">
      <p>Housika Properties is a technology platform operated under Pansoft Technologies Kenya (BN-36S5WLAP).</p>
      <p>
        <a href="mailto:customercare@housika.co.ke">📧 Email</a>
        <a href="https://wa.me/254785103445">📱 WhatsApp</a>
        <a href="tel:+254785103445">📞 Call</a>
        <a href="sms:+254785103445">💬 Message</a>
        <a href="https://facebook.com/housikaproperties">📘 Facebook</a>
      </p>
      <p style="font-size: 12px; color: #999;">This message is confidential and intended for the recipient only.</p>
    </div>
  </div>
</body>
</html>
  `;
}
