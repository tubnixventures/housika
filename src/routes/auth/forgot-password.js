import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { redis } from '../../utils/auth.js';
import { initZeptoMail } from '../../services/zeptoEmail.js';

const USERS_COLLECTION = 'users';

const forgotPassword = async (c) => {
  const timestamp = new Date().toISOString();

  try {
    const { email } = await c.req.json();
    if (!email || typeof email !== 'string') {
      return c.json({
        success: false,
        error: 'INVALID_EMAIL',
        message: 'Email is required and must be a string.',
        timestamp,
      }, 400);
    }

    const normalizedEmail = email.trim().toLowerCase();

    let usersCollection;
    try {
      usersCollection = await getCollection(USERS_COLLECTION);
      console.log('📦 Connected to collection:', USERS_COLLECTION);
    } catch (err) {
      console.error('❌ DB connection error:', err.message || err);
      return c.json({
        success: false,
        error: 'DB_CONNECTION_FAILED',
        message: 'Database connection failed.',
        timestamp,
      }, 503);
    }

    let user;
    try {
      const result = await usersCollection.find({ email: { $eq: normalizedEmail } });
      user = Object.values(result?.data || {})[0] || null;
    } catch (err) {
      console.error('❌ Failed to query user:', err.message || err);
      return c.json({
        success: false,
        error: 'DB_QUERY_FAILED',
        message: 'User lookup failed.',
        timestamp,
      }, 500);
    }

    if (!user) {
      return c.json({
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'Account does not exist.',
        timestamp,
      }, 404);
    }

    const resetToken = crypto.randomUUID();
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const ttl = 3600;

    try {
      await redis.set(`reset:${resetToken}`, user.id, { ex: ttl });
      await redis.set(`otp:${normalizedEmail}`, otp, { ex: ttl });
    } catch (err) {
      console.error('❌ Redis error:', err.message || err);
      return c.json({
        success: false,
        error: 'REDIS_ERROR',
        message: 'Failed to store reset token or OTP.',
        timestamp,
      }, 500);
    }

    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
    const recipientName = user.fullname || 'User';

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
      margin: auto;
      background-color: #ffffff;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 0 10px rgba(0,0,0,0.05);
    }
    h2 {
      color: #b31b1b;
      margin-bottom: 10px;
    }
    p {
      color: #333333;
      font-size: 16px;
      line-height: 1.6;
    }
    .otp {
      font-size: 24px;
      font-weight: bold;
      color: #0078D4;
      margin: 20px 0;
    }
    .cta {
      display: inline-block;
      margin-top: 20px;
      padding: 12px 20px;
      background-color: #0078D4;
      color: #ffffff;
      text-decoration: none;
      border-radius: 4px;
      font-weight: bold;
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
    <h2>Reset Your Housika Password</h2>
    <p>Dear ${recipientName},</p>
    <p>We received a request to reset your password. Use the OTP below to verify your identity:</p>
    <div class="otp">${otp}</div>
    <p>Or click the button below to reset your password directly:</p>
    <a href="${resetLink}" class="cta">Reset Password</a>
    <p>If you did not request this, please ignore this email.</p>
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

    const zepto = initZeptoMail(process.env);

    try {
      await zepto.sendPasswordReset({
        to: normalizedEmail,
        subject: 'Reset your Housika password',
        htmlbody,
        recipientName,
      });
    } catch (err) {
      console.error('❌ Email dispatch failed:', err.message || err);
      return c.json({
        success: false,
        error: 'EMAIL_FAILED',
        message: 'Failed to send reset email.',
        timestamp,
      }, 500);
    }

    return c.json({
      success: true,
      message: 'Reset link and OTP sent successfully. Check your email.',
      timestamp,
    });
  } catch (err) {
    console.error('🔥 Forgot-password error:', err.message || err);
    return c.json({
      success: false,
      error: 'UNEXPECTED_ERROR',
      message: 'Unexpected server error.',
      timestamp,
    }, 500);
  }
};

export default forgotPassword;
