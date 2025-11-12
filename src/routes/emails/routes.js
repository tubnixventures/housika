import { Hono } from 'hono';

import { postCustomerCareEmail } from './customerCare.js';
import { postCeoEmail } from './ceo.js';
import { postAdminEmail } from './admin.js';
import { postPaymentEmail } from './payments.js'; // ✅ Import Payment email handler

const emailRoutes = new Hono();

/**
 * Public route for customer care emails
 */
emailRoutes.post('/customercare', postCustomerCareEmail);

/**
 * Public route for payment confirmation emails
 */
emailRoutes.post('/payments', postPaymentEmail);

/**
 * Protected route for CEO executive emails
 */
emailRoutes.post('/ceo', postCeoEmail);

/**
 * Protected route for Admin desk emails
 */
emailRoutes.post('/admin', postAdminEmail);

export default emailRoutes;
