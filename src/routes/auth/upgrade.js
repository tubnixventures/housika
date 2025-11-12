import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { checkToken, deleteToken, assignToken } from '../../utils/auth.js';
import { initZeptoMail } from '../../services/zeptoEmail.js';

const USERS_COLLECTION = 'users';

const ROLE_TRANSITIONS = {
  user: ['landlord', 'dual', 'real_estate_company', 'agent'],
  tenant: ['landlord', 'dual', 'real_estate_company', 'agent'],
  landlord: ['real_estate_company', 'agent'],
  real_estate_company: ['landlord', 'agent', 'user'],
};

const upgrade = async (c) => {
  const timestamp = new Date().toISOString();
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid token.',
      timestamp,
    }, 401);
  }

  const oldToken = authHeader.split(' ')[1];
  const decoded = await checkToken(oldToken);

  if (!decoded) {
    return c.json({
      success: false,
      error: 'TOKEN_INVALID',
      message: 'Invalid or expired token.',
      timestamp,
    }, 401);
  }

  const { userId, role: currentRole, email, name } = decoded;
  const { newRole } = await c.req.json();

  const allowed = ROLE_TRANSITIONS[currentRole];
  if (!allowed || !allowed.includes(newRole)) {
    return c.json({
      success: false,
      error: 'ROLE_NOT_ELIGIBLE',
      message: `Role "${currentRole}" cannot transition to "${newRole}".`,
      timestamp,
    }, 403);
  }

  let usersCollection;
  try {
    usersCollection = await getCollection(USERS_COLLECTION);
  } catch (err) {
    console.error('❌ DB connection error:', err.message || err);
    return c.json({
      success: false,
      error: 'DB_CONNECTION_FAILED',
      message: 'Database connection failed.',
      timestamp,
    }, 503);
  }

  try {
    await usersCollection.patch(userId, {
      role: newRole,
      updatedat: new Date(),
    });
  } catch (err) {
    console.error('❌ Role update failed:', err.message || err);
    return c.json({
      success: false,
      error: 'ROLE_UPDATE_FAILED',
      message: 'Failed to upgrade role.',
      timestamp,
    }, 500);
  }

  try {
    await deleteToken(userId, oldToken);
  } catch (err) {
    console.warn('⚠️ Token deletion warning:', err.message || err);
  }

  let newToken;
  try {
    newToken = await assignToken({ userId, email, role: newRole });
  } catch (err) {
    console.error('❌ Token generation failed:', err.message || err);
    return c.json({
      success: false,
      error: 'TOKEN_GENERATION_FAILED',
      message: 'Failed to generate new token.',
      timestamp,
    }, 500);
  }

  // 🎉 Send congratulatory email
  try {
    const zepto = await initZeptoMail(c.env);
    const subject = `🎉 Congratulations on Your New Role – ${newRole}`;
    const htmlbody =`<!DOCTYPE html>
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
      text-align: center;
    }
    .tick-icon {
      margin-bottom: 30px;
    }
    h2 {
      color: #2c3e50;
      font-size: 24px;
      margin-bottom: 16px;
    }
    p {
      color: #555555;
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
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="tick-icon">
      <svg width="80" height="80" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="10" fill="#28a745"/>
        <path d="M7 12.5L10 15.5L17 8.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <h2>Congratulations, ${name || 'User'}!</h2>
    <p>Your role has been successfully upgraded to <strong>${newRole}</strong> on Housika Properties.</p>
    <p>We’re excited to see what you’ll accomplish next. Welcome to your new journey!</p>
    <div class="footer">
      <p>Housika Properties is a platform operated under Pansoft Technologies Kenya.</p>
      <p>For support, contact <a href="mailto:customercare@housika.co.ke">customercare@housika.co.ke</a></p>
    </div>
  </div>
</body>
</html>
`;

    await zepto.sendCustomerCareReply({
      to: email,
      subject,
      htmlbody,
      recipientName: name || 'User',
    });
  } catch (err) {
    console.error('❌ Email dispatch failed:', err.message || err);
  }

  c.header(
    'Set-Cookie',
    `token=${newToken}; HttpOnly; Path=/; Max-Age=604800; SameSite=Strict${
      process.env.NODE_ENV === 'production' ? '; Secure' : ''
    }`
  );

  return c.json({
    success: true,
    message: `Role changed from ${currentRole} to ${newRole}.`,
    newRole,
    token: newToken,
    timestamp,
  });
};

export default upgrade;
