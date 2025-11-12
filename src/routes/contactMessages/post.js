import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { initZeptoMail } from '../../services/zeptoEmail.js';

export const postContactMessage = async (c) => {
  const start = Date.now();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const timestamp = new Date().toISOString();

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

  const audit = {
    ip: c.req.header('x-forwarded-for') || '',
    useragent: c.req.header('user-agent') || '',
    traceid: traceId,
  };

  const messageRecord = {
    name,
    email,
    message,
    created_at: timestamp,
    ...audit,
  };

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

  let result;
  try {
    result = await contactMessages.post(messageRecord);
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

  if (zepto) {
    try {
      const subject = `Housika Customer Message Received – ${new Date().toLocaleDateString()}`;
      const htmlbody = generateCustomerCareEmail(name);
      await zepto.sendCustomerCareReply({
        to: email,
        subject,
        htmlbody,
        recipientName: name,
      });
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('⚠️ Email dispatch failed:', err.message || err);
      }
    }
  }

  return c.json({
    success: true,
    message: '✅ Message received successfully. Our Customer Care Desk will respond shortly.',
    id: result.documentId || result.insertedId || null,
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
    body {
      margin: 0;
      padding: 0;
      font-family: 'Segoe UI', Roboto, Arial, sans-serif;
      background-color: #f4f4f4;
    }
    .container {
      max-width: 700px;
      margin: auto;
      background-color: #ffffff;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 0 10px rgba(0,0,0,0.05);
    }
    h2 {
      color: #b31b1b;
      margin-bottom: 10px;
    }
    p {
      color: #333333;
      font-size: 16px;
      line-height: 1.6;
    }
    .footer {
      margin-top: 40px;
      font-size: 13px;
      color: #777777;
      text-align: center;
    }
    .footer a {
      color: #b31b1b;
      text-decoration: none;
      margin: 0 10px;
    }
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
