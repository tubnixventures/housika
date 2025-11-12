import { initZeptoMail, ZeptoMailError } from '../../services/zeptoEmail.js';
import { checkToken } from '../../utils/auth.js';

/**
 * POST /emails/ceo
 * Sends an executive email from Housika CEO.
 * Restricted to ceo role.
 */
export const postCeoEmail = async (c) => {
  const timestamp = new Date().toISOString();

  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
  } catch (err) {
    console.error('❌ JSON parsing failed:', err.message || err);
    return c.json({
      success: false,
      error: 'INVALID_JSON',
      message: 'Request body must be valid JSON.',
      timestamp,
    }, 400);
  }

  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const user = token ? await checkToken(token) : null;

  if (!user || user.role !== 'ceo') {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only CEO is authorized to send executive emails.',
      timestamp,
    }, 403);
  }

  const { to, message, time } = body;
  if (!to || !message || !time) {
    return c.json({
      success: false,
      error: 'MISSING_FIELDS',
      message: 'Required fields: to, message, and time must be provided.',
      timestamp,
    }, 400);
  }

  try {
    const zepto = await initZeptoMail(c.env);
    const subject = `Executive Notice – ${new Date(time).toLocaleDateString()}`;
    const htmlbody = `
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
      margin: 40px auto;
      background-color: #ffffff;
      padding: 40px;
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
    }
    h2 {
      color: #1b3bb3;
      margin-bottom: 10px;
    }
    p {
      color: #333333;
      font-size: 16px;
      line-height: 1.6;
      margin: 12px 0;
    }
    .footer {
      margin-top: 40px;
      font-size: 13px;
      color: #777777;
      text-align: center;
    }
    .footer a {
      color: #1b3bb3;
      text-decoration: none;
      margin: 0 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>Housika Properties – Office of the CEO</h2>
    <p>Dear Stakeholder,</p>
    <p>${message}</p>
    <p style="font-size: 14px; color: #555;">
      This communication is issued directly by the CEO of Housika Properties and logged for audit purposes.
    </p>
    <div class="footer">
      <p>Housika Properties is operated under Pansoft Technologies Kenya (BN-36S5WLAP).</p>
      <p>Current CEO: <strong>Movin Wanjala Juma</strong></p>
      <p>Contact: <a href="mailto:ceo@housika.co.ke">ceo@housika.co.ke</a></p>
      <p>
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

    const result = await zepto.sendCustomerCareReply({
      to,
      subject,
      htmlbody,
      recipientName: 'Stakeholder',
    });

    return c.json({
      success: true,
      message: 'Executive email sent successfully.',
      result,
      timestamp,
    });
  } catch (err) {
    console.error('❌ Email dispatch failed:', err.message || err);
    const errorType = err instanceof ZeptoMailError ? 'EMAIL_SERVICE_ERROR' : 'REQUEST_ERROR';
    return c.json({
      success: false,
      error: errorType,
      message: err.message || 'Unexpected error during email dispatch.',
      timestamp,
    }, 500);
  }
};
