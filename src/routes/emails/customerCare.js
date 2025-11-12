import { initZeptoMail, ZeptoMailError } from '../../services/zeptoEmail.js';

/**
 * POST /emails/customercare
 * Sends a professional customer care email from Housika Properties.
 * Public access.
 */
export const postCustomerCareEmail = async (c) => {
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
    const subject = `Housika Customer Care Response – ${new Date(time).toLocaleDateString()}`;
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
      color: #b31b1b;
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
      color: #b31b1b;
      text-decoration: none;
      margin: 0 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>Housika Properties – Customer Care Desk</h2>
    <p>Dear Customer,</p>
    <p>${message}</p>
    <hr style="margin: 30px 0; border: none; border-top: 1px solid #ccc;" />
    <p style="font-size: 14px; color: #555;">
      Housika Properties is a global house and land marketplace platform connecting landlords and tenants. 
      We are a subsidiary of Pansoft Technologies Kenya (BN-36S5WLAP).
    </p>
    <p style="font-size: 14px; color: #555;">
      <strong>Note:</strong> We do not collect rent on behalf of landlords. Our services include listing, application processing, and free tamper-proof receipt generation. 
      All receipts are verifiable by any party.
    </p>
    <p style="font-size: 14px; color: #555;">
      For privacy and security, please avoid sharing sensitive data with customer care officers. 
      If your concern requires confidentiality, contact <a href="mailto:ceo@housika.co.ke">ceo@housika.co.ke</a>.
    </p>
    <p style="font-size: 14px; color: #555;">
      Thank you for choosing Housika Properties.
    </p>
    <p style="font-size: 14px; color: #b31b1b;">— Housika Customer Care Team</p>
    <div class="footer">
      <p>Need help? Reach us via:</p>
      <p>
        <a href="https://wa.me/254785103445">📱 WhatsApp</a>
        <a href="tel:+254785103445">📞 Call</a>
        <a href="sms:+254785103445">💬 Message</a>
        <a href="https://facebook.com/housikaproperties">📘 Facebook</a>
      </p>
    </div>
  </div>
</body>
</html>
    `;

    const result = await zepto.sendCustomerCareReply({
      to,
      subject,
      htmlbody,
      recipientName: 'Customer',
    });

    return c.json({
      success: true,
      message: 'Customer care email sent successfully.',
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
