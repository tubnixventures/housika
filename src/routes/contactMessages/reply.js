import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';
import { initZeptoMail } from '../../services/zeptoEmail.js';

/**
 * POST /contactMessages/reply
 * Sends a reply to a contact message and stores it in the DB.
 * Only accessible by customer care, admin, or ceo.
 */
export const replyToContactMessage = async (c) => {
  const timestamp = new Date().toISOString();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  const [actorResult, messagesResult, repliesResult] = await Promise.allSettled([
    token ? checkToken(token) : null,
    getCollection('contact_messages'),
    getCollection('contact_replies'),
  ]);

  const actor = actorResult.status === 'fulfilled' ? actorResult.value : null;
  const messagesCol = messagesResult.status === 'fulfilled' ? messagesResult.value : null;
  const repliesCol = repliesResult.status === 'fulfilled' ? repliesResult.value : null;

  if (!actor || !['customer care', 'admin', 'ceo'].includes(actor.role)) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only customer care, admin, or ceo can reply to messages.',
      timestamp,
      traceId,
    }, 403);
  }

  if (!messagesCol || !repliesCol) {
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
      traceId,
    }, 503);
  }

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

  const { message_id, reply_body } = body;
  if (!message_id || !reply_body) {
    return c.json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'message_id and reply_body are required.',
      timestamp,
      traceId,
    }, 400);
  }

  let originalMessage;
  try {
    const result = await messagesCol.find({ _id: message_id });
    originalMessage = Object.values(result?.data || {})[0];
    if (!originalMessage) {
      return c.json({
        success: false,
        error: 'MESSAGE_NOT_FOUND',
        message: `No contact message found with ID "${message_id}".`,
        timestamp,
        traceId,
      }, 404);
    }
  } catch (err) {
    return c.json({
      success: false,
      error: 'QUERY_FAILED',
      message: 'Failed to retrieve contact message.',
      timestamp,
      traceId,
    }, 500);
  }

  const replyRecord = {
    message_id,
    customer_id: originalMessage.user_id || null,
    customer_email: originalMessage.email,
    reply_body,
    served_by_id: actor.userId,
    served_by_name: actor.name || actor.email,
    served_by_role: actor.role,
    replied_at: timestamp,
    audit_ip: c.req.header('x-forwarded-for') || '',
    audit_useragent: c.req.header('user-agent') || '',
    audit_traceid: traceId,
  };

  try {
    await repliesCol.post(replyRecord);
  } catch (err) {
    return c.json({
      success: false,
      error: 'INSERT_FAILED',
      message: 'Failed to store reply.',
      timestamp,
      traceId,
    }, 500);
  }

  // 📧 Send reply email
  try {
    const zepto = await initZeptoMail(c.env);
    const subject = `Reply from Housika Customer Care`;
    const htmlbody = generateProfessionalReplyEmail(originalMessage.name, reply_body, actor.name || actor.email);
    await zepto.sendCustomerCareReply({
      to: originalMessage.email,
      subject,
      htmlbody,
      recipientName: originalMessage.name,
    });
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('⚠️ Email dispatch failed:', err.message || err);
    }
  }

  return c.json({
    success: true,
    message: 'Reply sent and stored successfully.',
    replied_at: timestamp,
    served_by: replyRecord.served_by_name,
    traceId,
  }, 200);
};

/**
 * Generates a full professional HTML email body
 */
function generateProfessionalReplyEmail(name, replyBody, responderName) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Housika Customer Care Reply</title>
  <style>
    body {
      font-family: 'Segoe UI', Roboto, Arial, sans-serif;
      background-color: #f9f9f9;
      margin: 0;
      padding: 0;
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
      margin-bottom: 20px;
    }
    p {
      font-size: 16px;
      color: #333333;
      line-height: 1.6;
    }
    .signature {
      margin-top: 30px;
      font-size: 15px;
      color: #555555;
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
      margin: 0 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>Housika Properties – Customer Care Reply</h2>
    <p>Dear ${name},</p>
    <p>${replyBody}</p>
    <div class="signature">
      <p>Kind regards,</p>
      <p><strong>${responderName}</strong><br/>Housika Customer Care</p>
    </div>
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
