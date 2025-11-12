import { Hono } from 'hono';

import authRoutes from './auth/routes.js';
import roomsRoutes from './rooms/routes.js';
import propertiesRoutes from './properties/routes.js';
import countriesRoutes from './countries/routes.js';
import bannersRoutes from './banners/routes.js';
import contactMessagesRoutes from './contactMessages/routes.js';
import chatsRoutes from './chats/routes.js';
import uploadRoutes from './upload/routes.js';
import usersRoutes from './users/routes.js';
import emailRoutes from './emails/routes.js';
import bookingsRoutes from './bookings/routes.js';
import paymentsRoutes from './payments/routes.js';
import receiptRoutes from './receipts/routes.js';

const app = new Hono();

// --- Public Routes ---
app.route('/contactMessages', contactMessagesRoutes);
app.route('/banners', bannersRoutes);
app.route('/countries', countriesRoutes);
app.route('/upload', uploadRoutes);
app.route('/emails', emailRoutes);
app.route('/payments', paymentsRoutes);
app.route('/receipts', receiptRoutes);

// --- Authenticated API Routes ---
app.route('/auth', authRoutes);
app.route('/properties', propertiesRoutes);
app.route('/rooms', roomsRoutes);
app.route('/chats', chatsRoutes);
app.route('/users', usersRoutes);
app.route('/bookings', bookingsRoutes);

// --- Health Check ---
app.get('/', (c) => c.text('✅ Hono API ready'));

export default app;
