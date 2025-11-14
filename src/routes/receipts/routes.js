// src/routes/receipts/index.js
import { Hono } from 'hono';
import verify from './verify.js';
import receipts from './post.js';
import list from './list.js';
import mine from './mine/[receipt_id].js';

const receiptRoutes = new Hono();

// Public verification (kept exactly as /verify/:receipt_id)
receiptRoutes.get('/verify/:receipt_id', verify);

// Create receipt (POST /receipts)
receiptRoutes.post('/', receipts);

// Landlord / dual routes
receiptRoutes.get('/mine', list);               // GET /receipts/mine
receiptRoutes.get('/mine/:receipt_id', mine);   // GET /receipts/mine/:receipt_id

// Health check (optional)
receiptRoutes.get('/_health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

export default receiptRoutes;
