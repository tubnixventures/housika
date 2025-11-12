import { initZeptoMail, ZeptoMailError } from '../../services/zeptoEmail.js';

/**
 * POST /emails/payments
 * Sends a payment confirmation email from Housika Properties.
 * Public access – no token required.
 */
export const postPaymentEmail = async (c) => {
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

  const { to, reference, time, purpose } = body;
  if (!to || !reference || !time || !purpose) {
    return c.json({
      success: false,
      error: 'MISSING_FIELDS',
      message: 'Required fields: to, reference, time, and purpose must be provided.',
      timestamp,
    }, 400);
  }

  try {
    const zepto = await initZeptoMail(c.env);
    const subject = `Payment Confirmation – ${new Date(time).toLocaleDateString()}`;
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
      color: #28a745;
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
    <h2>Payment Confirmation – Housika Properties</h2>
    <p>Dear Customer,</p>
    <p>We’ve received your payment successfully.</p>
    <p><strong>Reference:</strong> ${reference}</p>
    <p><strong>Time Paid:</strong> ${new Date(time).toLocaleString()}</p>
    <p><strong>Purpose:</strong> ${purpose}</p>
    <p>This transaction has been logged and verified. You may retain this email as proof of payment.</p>
    <div class="footer">
      <p>Housika Properties is operated under Pansoft Technologies Kenya (BN-36S5WLAP).</p>
      <p>Need help? <a href="mailto:customercare@housika.co.ke">customercare@housika.co.ke</a></p>
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
      message: 'Payment confirmation email sent successfully.',
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
