import { checkToken } from '../../utils/auth.js';
import { initR2 } from '../../services/r2.js';
import { getCollection } from '../../services/astra.js';
import { v4 as uuid } from 'uuid';
import puppeteer from 'puppeteer';
import QRCode from 'qrcode';

const receipts = async (c) => {
  const start = Date.now();
  const traceId = c.req.header('x-trace-id') || uuid();
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const timestamp = new Date().toISOString();

  const user = token ? await checkToken(token) : null;
  const allowedRoles = ['landlord', 'dual', 'agent', 'real estate company'];

  if (!user || !allowedRoles.includes(user.role)) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only authorized roles can generate receipts.',
      timestamp,
      traceId,
    }, 403);
  }

  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
  } catch (err) {
    console.error('❌ Body parse error:', err.message || err);
    return c.json({
      success: false,
      error: 'INVALID_BODY',
      message: 'Request body must be valid JSON.',
      timestamp,
      traceId,
    }, 400);
  }

  const { tenant_name, property_name, next_payment_date } = body;
  if (!tenant_name || !property_name) {
    return c.json({
      success: false,
      error: 'MISSING_FIELDS',
      message: 'tenant_name and property_name are required.',
      timestamp,
      traceId,
    }, 400);
  }

  const receipt_id = `RCT-${uuid()}`;
  const verifyUrl = `https://housika.io/verify?receipt_id=${receipt_id}`;
  const qrCodeBase64 = await QRCode.toDataURL(verifyUrl);

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: 'Segoe UI', sans-serif; padding: 40px; color: #333; }
        .header { text-align: center; margin-bottom: 30px; }
        .qr { float: right; width: 100px; }
        .info { margin-bottom: 20px; }
        .label { font-weight: bold; }
        .footer { margin-top: 40px; font-size: 0.9em; color: #777; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Housika Property Receipt</h1>
        <img class="qr" src="${qrCodeBase64}" />
      </div>
      <div class="info">
        <p><span class="label">Receipt ID:</span> ${receipt_id}</p>
        <p><span class="label">Tenant Name:</span> ${tenant_name}</p>
        <p><span class="label">Property Name:</span> ${property_name}</p>
        ${next_payment_date ? `<p><span class="label">Next Payment Date:</span> ${next_payment_date}</p>` : ''}
        <p><span class="label">Issued By:</span> ${user.role} (${user.userId})</p>
        <p><span class="label">Issued At:</span> ${timestamp}</p>
      </div>
      <div class="footer">
        Scan the QR code to verify this receipt at housika.io/verify
      </div>
    </body>
    </html>
  `;

  try {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    const r2 = await initR2();
    const key = r2.generateFilename('pdf', 'receipts');
    const public_url = r2.generatePublicUrl(key);
    await r2.uploadFile(key, pdfBuffer, 'application/pdf');

    const receiptsCol = await getCollection('receipts');
    await receiptsCol.post({
      receipt_id,
      tenant_name,
      property_name,
      next_payment_date,
      created_by: user.userId,
      created_role: user.role,
      created_at: timestamp,
      public_url,
    });

    return c.json({
      success: true,
      message: 'Receipt PDF generated and saved to R2.',
      receipt_id,
      public_url,
      download_url: await r2.generateUploadUrl(key, 'application/pdf'),
      verify_url: verifyUrl,
      timestamp,
      traceId,
      duration: `${Date.now() - start}ms`,
    }, 200);
  } catch (err) {
    console.error('❌ Receipt generation failed:', err.message || err);
    return c.json({
      success: false,
      error: 'GENERATION_FAILED',
      message: 'Unable to generate or upload receipt.',
      timestamp,
      traceId,
    }, 500);
  }
};

export default receipts;
