// receipts.handler.js
import { checkToken } from '../../utils/auth.js';
import { initR2 } from '../../services/r2.js';
import { getCollection } from '../../services/astra.js';
import { v4 as uuid } from 'uuid';
import puppeteer from 'puppeteer';
import QRCode from 'qrcode';

// NOTE: Use a deterministic decimal library for critical finance paths if you need >2 decimal precision.
// This implementation uses integer smallest-unit storage (cents) to avoid floating-point errors.

// Configuration
const ALLOWED_ROLES = new Set(['landlord', 'dual', 'agent', 'real estate company']);
const IDEMPOTENCY_HEADER = 'x-idempotency-key';
const SUPPORTED_CURRENCIES = new Set(['KES', 'USD', 'EUR', 'GBP']); // Extend as needed
const UPLOAD_RETRY_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAY_MS = 300; // exponential backoff base

// Utility: sleep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Validate and normalize amount input
// Accepts either:
// - amount_value (integer smallest unit) + amount_currency (ISO) OR
// - legacy `amount` string like "KES 2,500.00" or "2500.00" with optional currencyHint param
const parseAndNormalizeAmount = (body, currencyHint = null) => {
  // Return shape: { amount_value: Number (integer smallest unit), amount_currency: string, amount_display: string }
  // Throw Error with message on invalid input.
  const { amount_value, amount_currency, amount, raw_amount_input } = body;

  // If explicit smallest-unit provided, validate
  if (typeof amount_value !== 'undefined') {
    if (!amount_currency || typeof amount_currency !== 'string')
      throw new Error('amount_currency is required when amount_value is provided');
    const currency = amount_currency.toUpperCase();
    if (!SUPPORTED_CURRENCIES.has(currency)) throw new Error('Unsupported currency');
    if (!Number.isInteger(amount_value) || amount_value < 0) throw new Error('amount_value must be a non-negative integer');
    const amount_display = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount_value / 100);
    return { amount_value, amount_currency: currency, amount_display };
  }

  // Legacy parsing path: try to parse `amount` or `raw_amount_input`
  const raw = (typeof amount !== 'undefined') ? String(amount) : (raw_amount_input ? String(raw_amount_input) : null);
  if (!raw) throw new Error('Missing amount_value or legacy amount input');

  // Extract currency symbol or token if present
  let currency = null;
  let numeric = raw.trim();

  // Detect currency token at start like "KES 2,500.00" or "$2,500.00"
  const tokenMatch = numeric.match(/^([A-Za-z]{3})\s*(.+)$/);
  if (tokenMatch) {
    currency = tokenMatch[1].toUpperCase();
    numeric = tokenMatch[2];
  } else if (currencyHint) {
    currency = currencyHint.toUpperCase();
  } else {
    // default to KES if you prefer; for safety require explicit currency in production
    throw new Error('Currency not provided. Provide amount_currency or use 3-letter currency prefix in amount (e.g., "KES 2500.00")');
  }

  if (!SUPPORTED_CURRENCIES.has(currency)) throw new Error('Unsupported currency');

  // Remove grouping separators and any non-numeric except dot and comma
  numeric = numeric.replace(/[, ]+/g, '').replace(/[^\d.]/g, '');
  if (!numeric || !/^\d+(\.\d+)?$/.test(numeric)) throw new Error('Invalid numeric amount');

  // Convert to smallest unit (two decimal places)
  const parts = numeric.split('.');
  let integerPart = parts[0];
  let fractionPart = (parts[1] || '').padEnd(2, '0').slice(0, 2);
  const amount_value_int = Number(integerPart) * 100 + Number(fractionPart);

  if (!Number.isFinite(amount_value_int) || amount_value_int < 0) throw new Error('Invalid amount');
  const amount_display = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount_value_int / 100);
  return { amount_value: amount_value_int, amount_currency: currency, amount_display };
};

// Generate stable short receipt number
const generateReceiptNumber = () => {
  const timestampPart = Date.now().toString().slice(-8);
  const randomPart = Math.floor(Math.random() * 90 + 10).toString();
  return (timestampPart + randomPart).slice(-10);
};

const getReceiptColor = () => {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 12) return { bg: 'linear-gradient(145deg, #e0f7fa 0%, #b2ebf2 100%)', text: '#1F2937', primary: '#009688' };
  if (hour >= 12 && hour < 18) return { bg: 'linear-gradient(145deg, #fffde7 0%, #ffecb3 100%)', text: '#1F2937', primary: '#ff9800' };
  if (hour >= 18 && hour < 22) return { bg: 'linear-gradient(145deg, #f3e5f5 0%, #e1bee7 100%)', text: '#1F2937', primary: '#9c27b0' };
  return { bg: 'linear-gradient(145deg, #f5f5f5 0%, #cfd8dc 100%)', text: '#1F2937', primary: '#546e7a' };
};

// Upload helper with retry
const retryUpload = async (r2, key, buffer, contentType) => {
  let attempt = 0;
  while (attempt < UPLOAD_RETRY_ATTEMPTS) {
    try {
      await r2.uploadFile(key, buffer, contentType);
      return;
    } catch (err) {
      attempt += 1;
      if (attempt >= UPLOAD_RETRY_ATTEMPTS) throw err;
      await sleep(UPLOAD_RETRY_DELAY_MS * 2 ** (attempt - 1));
    }
  }
};

// Main handler
const receipts = async (c) => {
  const start = Date.now();
  const traceId = c.req.header('x-trace-id') || uuid();
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const timestamp = new Date().toISOString();

  // Basic auth check
  const user = token ? await checkToken(token) : null;
  if (!user || !ALLOWED_ROLES.has(user.role)) {
    return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Only authorized roles can generate receipts.', timestamp, traceId }, 403);
  }

  // Parse body
  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
  } catch (err) {
    return c.json({ success: false, error: 'INVALID_BODY', message: 'Request body must be valid JSON.', timestamp, traceId }, 400);
  }

  // Required fields
  const { tenant_name, property_name, next_payment_date, payment_method, details } = body;
  if (!tenant_name || !property_name) {
    return c.json({ success: false, error: 'MISSING_FIELDS', message: 'tenant_name and property_name are required.', timestamp, traceId }, 400);
  }

  // Idempotency: attempt to find an existing operation by idempotency key
  const idempotencyKey = c.req.header(IDEMPOTENCY_HEADER) || null;

  // Normalize amount (supports new and legacy shapes). currencyHint optional: read from user profile if desired.
  let normalizedAmount;
  try {
    normalizedAmount = parseAndNormalizeAmount(body, body.amount_currency || null);
  } catch (err) {
    return c.json({ success: false, error: 'INVALID_AMOUNT', message: err.message || 'Invalid amount', timestamp, traceId }, 400);
  }

  // Prepare IDs and urls
  const receipt_id = `RCT-${uuid()}`;
  const receipt_number = generateReceiptNumber();
  const verifyUrl = `https://housika.io/verify?receipt_number=${encodeURIComponent(receipt_number)}`;

  // Generate QR Code (base64)
  let qrCodeBase64;
  try {
    qrCodeBase64 = await QRCode.toDataURL(verifyUrl, { errorCorrectionLevel: 'H', width: 120 });
  } catch (err) {
    console.error('QR generation failed', err);
    return c.json({ success: false, error: 'QR_GENERATION_FAILED', message: 'Unable to create QR code', timestamp, traceId }, 500);
  }

  // Use formatted amount_display for PDF display
  const { amount_value, amount_currency, amount_display } = normalizedAmount;
  const colors = getReceiptColor();

  // Small server-side HTML template (escape values where necessary)
  const escapeHtml = (s) => String(s || '').replace(/[&<>"'`]/g, (ch) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',"`":'&#96;' }[ch]));

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Housika Receipt #${escapeHtml(receipt_number)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
    body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;padding:0;background:#f4f7f9}
    .container{max-width:600px;margin:40px auto;padding:32px;border-radius:12px;background:${colors.bg};color:${colors.text};box-shadow:0 10px 30px rgba(0,0,0,0.08)}
    .header{text-align:center;border-bottom:2px solid ${colors.primary}22;padding-bottom:18px;margin-bottom:18px}
    h1{color:${colors.primary};font-size:20px;margin:0 0 6px 0}
    .receipt-no{display:inline-block;background:${colors.primary}10;color:${colors.primary};padding:6px 10px;border-radius:6px;font-weight:600;font-size:12px}
    .qr{position:absolute;right:48px;top:48px;text-align:center}
    .qr img{width:110px;height:110px;border-radius:8px;border:4px solid #fff;box-shadow:0 6px 16px rgba(0,0,0,0.06)}
    .amount{background:${colors.primary}12;border-radius:8px;padding:20px;text-align:center;margin:22px 0}
    .amount .label{color:${colors.primary};font-weight:700}
    .amount .value{font-size:36px;color:${colors.primary};font-weight:800}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:12px 0}
    .item{background:#fff;padding:12px;border-radius:8px;border:1px solid rgba(0,0,0,0.05)}
    .label{font-size:11px;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:6px;display:block}
    .value{font-size:14px;color:${colors.text}}
    .footer{margin-top:22px;padding-top:14px;border-top:1px dashed rgba(0,0,0,0.08);font-size:12px;color:#6b7280;text-align:center}
  </style>
</head>
<body>
  <div class="container">
    <div class="qr"><img src="${qrCodeBase64}" alt="QR"/></div>
    <div class="header">
      <h1>HOUSIKA PROPERTY RENTAL RECEIPT</h1>
      <div class="receipt-no">Receipt No: ${escapeHtml(receipt_number)}</div>
    </div>

    <div class="amount">
      <div class="label">Total Amount Paid</div>
      <div class="value">${escapeHtml(amount_display)}</div>
    </div>

    <div class="grid">
      <div class="item"><span class="label">Tenant Name</span><div class="value">${escapeHtml(tenant_name)}</div></div>
      <div class="item"><span class="label">Property Name</span><div class="value">${escapeHtml(property_name)}</div></div>
      <div class="item"><span class="label">Payment Method</span><div class="value">${escapeHtml(payment_method || 'N/A')}</div></div>
      <div class="item"><span class="label">Next Payment Due</span><div class="value">${escapeHtml(next_payment_date || 'N/A')}</div></div>
      <div class="item" style="grid-column:1 / -1"><span class="label">Transaction Details</span><div class="value">${escapeHtml(details || 'Monthly rent payment.')}</div></div>
    </div>

    <div class="grid" style="margin-top:12px">
      <div class="item"><span class="label">Issued By</span><div class="value">${escapeHtml(user.role)} (${escapeHtml(user.userId?.substring?.(0,8) || '')}...)</div></div>
      <div class="item"><span class="label">Issued At</span><div class="value">${escapeHtml(timestamp.substring(0,10))} ${escapeHtml(timestamp.substring(11,19))}</div></div>
      <div class="item" style="grid-column:1 / -1"><span class="label">Internal ID (UUID)</span><div class="value">${escapeHtml(receipt_id)}</div></div>
    </div>

    <div class="footer">This is a legally binding receipt. Scan the QR code or visit housika.io/verify to authenticate using Receipt No. ${escapeHtml(receipt_number)}.</div>
  </div>
</body>
</html>`;

  // Render PDF using Puppeteer
  let pdfBuffer;
  try {
    // Puppeteer launch options tuned for containerized server environments
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();

    // Set viewport wide enough for template
    await page.setViewport({ width: 800, height: 1000, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Use explicit pdf size (pixel-based) or A4 depending on visual requirements
    pdfBuffer = await page.pdf({
      width: '640px',
      height: '900px',
      printBackground: true,
      margin: { top: '0.4in', right: '0.4in', bottom: '0.4in', left: '0.4in' },
    });

    await browser.close();
  } catch (err) {
    console.error('PDF generation error', err);
    return c.json({ success: false, error: 'PDF_GENERATION_FAILED', message: 'Unable to create receipt PDF', timestamp, traceId }, 500);
  }

  // Upload PDF to R2 (with retry). Use streaming API in r2.uploadFile if available.
  let public_url;
  try {
    const r2 = await initR2();
    const key = r2.generateFilename('pdf', 'receipts'); // expected impl in your r2 wrapper
    public_url = r2.generatePublicUrl(key);

    await retryUpload(r2, key, pdfBuffer, 'application/pdf');

    // If r2 supports signed short-lived URLs for download, generate them
    const download_url = await r2.generateUploadUrl(key, 'application/pdf');

    // Persist to DB
    const receiptsCol = await getCollection('receipts');

    // Idempotency: attempt to find existing record for this idempotencyKey
    if (idempotencyKey) {
      try {
        const existing = await receiptsCol.findOne({ idempotency_key: idempotencyKey });
        if (existing) {
          return c.json({
            success: true,
            message: 'Receipt already created for idempotency key',
            receipt_id: existing.receipt_id,
            receipt_number: existing.receipt_number,
            public_url: existing.public_url,
            download_url: existing.download_url,
            verify_url: existing.verify_url,
            timestamp,
            traceId,
            duration: `${Date.now() - start}ms`,
          }, 200);
        }
      } catch (e) {
        // proceed - do not fail idempotency lookup for DB errors
        console.warn('Idempotency lookup failed', e);
      }
    }

    // Save canonical record with separated amount fields and audit metadata
    const record = {
      receipt_id,
      receipt_number,
      tenant_name,
      property_name,
      amount_value, // integer smallest unit
      amount_currency,
      amount_display, // preformatted for PDF/UI
      payment_method: payment_method || 'Unknown',
      next_payment_date: next_payment_date || null,
      details: details || 'Monthly rent payment.',
      created_by: user.userId,
      created_role: user.role,
      created_at: timestamp,
      public_url,
      download_url,
      verify_url: verifyUrl,
      trace_id: traceId,
      idempotency_key: idempotencyKey || null,
      // Optionally: raw_input: body (careful with PII)
    };

    await receiptsCol.post(record);

    // Return success
    return c.json({
      success: true,
      message: 'Professional Receipt generated and saved successfully.',
      receipt_id,
      receipt_number,
      public_url,
      download_url,
      verify_url: verifyUrl,
      timestamp,
      traceId,
      duration: `${Date.now() - start}ms`,
    }, 200);
  } catch (err) {
    console.error('Storage/upload error', err);
    // Attempt best-effort cleanup if you uploaded but DB failed (not implemented here).
    return c.json({ success: false, error: 'GENERATION_FAILED', message: 'Unable to generate or upload receipt.', timestamp, traceId }, 500);
  }
};

export default receipts;
