// services/email.js
import { initZeptoMail } from './zeptoEmail.js';

// Initialize ZeptoMail once
let zepto;
(async () => {
  zepto = await initZeptoMail();
})();

/**
 * sendEmail
 * Dedicated helper for sending payment-related emails.
 *
 * @param {Object} params
 * @param {string} params.to - Recipient email address
 * @param {string} params.reference - Payment reference (server-generated)
 * @param {number} params.amount - Payment amount
 * @param {string} params.paymentUrl - URL for completing payment
 * @param {string} [params.recipientName] - Optional recipient name
 */
export async function sendEmail({ to, reference, amount, paymentUrl, recipientName = 'User' }) {
  if (!zepto) {
    zepto = await initZeptoMail();
  }

  const subject = `Complete your payment - Ref ${reference}`;

  // Full HTML email body
  const htmlbody = `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${subject}</title>
      <style>
        body {
          margin: 0;
          padding: 0;
          background-color: #f9fafb;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          color: #111827;
        }
        .container {
          max-width: 600px;
          margin: 40px auto;
          background: #ffffff;
          border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.05);
          overflow: hidden;
        }
        .header {
          background-color: #4f46e5;
          color: #ffffff;
          padding: 20px;
          text-align: center;
          font-size: 20px;
          font-weight: bold;
        }
        .content {
          padding: 30px;
          line-height: 1.6;
        }
        .content p {
          margin: 0 0 16px;
        }
        .button {
          display: inline-block;
          padding: 12px 20px;
          background-color: #4f46e5;
          color: #ffffff !important;
          text-decoration: none;
          border-radius: 6px;
          font-weight: 600;
        }
        .footer {
          background-color: #f3f4f6;
          padding: 20px;
          text-align: center;
          font-size: 12px;
          color: #6b7280;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">Housika Payments</div>
        <div class="content">
          <p>Hello ${recipientName},</p>
          <p>Please complete your payment using the link below:</p>
          <p><strong>Reference:</strong> ${reference}<br/>
             <strong>Amount:</strong> ${amount}</p>
          <p style="text-align:center;">
            <a href="${paymentUrl}" class="button">Pay Now</a>
          </p>
          <p>If you have any questions, please contact our customer care team.</p>
          <p>Regards,<br/>Housika Payments Team</p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} Housika Properties. All rights reserved.<br/>
          This is an automated email, please do not reply.
        </div>
      </div>
    </body>
  </html>
  `;

  // Use the dedicated sender for payments
  return zepto.sendPaymentUrlEmail({
    to,
    reference,
    amount,
    paymentUrl,
    recipientName,
    htmlbody, // override with full HTML
    subject,
  });
}
