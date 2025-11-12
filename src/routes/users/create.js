import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';
import { initZeptoMail } from '../../services/zeptoEmail.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export const createUser = async (c) => {
  const start = Date.now();
  const traceId = c.req.header('x-trace-id') || crypto.randomUUID();
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const timestamp = new Date().toISOString();

  const [creator, usersCollection] = await Promise.all([
    token ? checkToken(token) : null,
    getCollection('users'),
  ]);

  if (!creator || !['admin', 'customer care', 'ceo'].includes(creator.role)) {
    return c.json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Only admin, customer care, or ceo can create users.',
      timestamp,
      traceId,
    }, 403);
  }

  let body;
  try {
    body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
  } catch {
    return c.json({
      success: false,
      error: 'INVALID_BODY',
      message: 'Request body must be valid JSON.',
      timestamp,
      traceId,
    }, 400);
  }

  const { email, password, role, phonenumber, fullname } = body;
  if (!email || !password || !role || !phonenumber || !fullname) {
    return c.json({
      success: false,
      error: 'MISSING_FIELDS',
      message: 'Required fields: email, password, role, phonenumber, fullname.',
      timestamp,
      traceId,
    }, 400);
  }

  if (role === 'ceo') {
    return c.json({
      success: false,
      error: 'ROLE_NOT_ALLOWED',
      message: 'Cannot create user with role "ceo".',
      timestamp,
      traceId,
    }, 403);
  }

  try {
    const existing = await usersCollection.find({ email: { $eq: email } });
    if (Object.keys(existing?.data || {}).length > 0) {
      return c.json({
        success: false,
        error: 'USER_EXISTS',
        message: `User with email "${email}" already exists.`,
        timestamp,
        traceId,
      }, 409);
    }
  } catch (err) {
    console.error('❌ Lookup failed:', err.message || err);
    return c.json({
      success: false,
      error: 'LOOKUP_FAILED',
      message: 'Failed to check for existing user.',
      timestamp,
      traceId,
    }, 500);
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const userId = crypto.randomUUID();

  const userToCreate = {
    _id: userId,
    email,
    password: hashedPassword,
    role,
    phonenumber,
    fullname,
    created_by: creator.userId,
    created_at: timestamp,
  };

  try {
    await usersCollection.post(userToCreate);

    // 📧 Fire-and-forget welcome email
    void (async () => {
      try {
        const zepto = await initZeptoMail(c.env);
        const subject = `🎉 Welcome to Housika – Your ${role} Account Is Ready`;
        const htmlbody = generateWelcomeEmail(fullname, role);
        await zepto.sendCustomerCareReply({
          to: email,
          subject,
          htmlbody,
          recipientName: fullname,
        });
      } catch (emailErr) {
        console.warn('⚠️ Welcome email dispatch failed:', emailErr.message || emailErr);
      }
    })();

    return c.json({
      success: true,
      message: 'User created successfully.',
      insertedId: userId,
      timestamp,
      traceId,
      duration: `${Date.now() - start}ms`,
    }, 201);
  } catch (err) {
    console.error('❌ Insert failed:', err.message || err);
    return c.json({
      success: false,
      error: 'INSERT_FAILED',
      message: 'Failed to create user.',
      timestamp,
      traceId,
    }, 500);
  }
};


function generateWelcomeEmail(name, role) {
  return `
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
    <h2>Welcome to Housika, ${name}!</h2>
    <p>Your account has been successfully created with the role: <strong>${role}</strong>.</p>
    <p>You can now log in and begin managing your listings, bookings, or support tasks depending on your assigned role.</p>
    <p>If you have any questions, reach us via:</p>
    <p>
      📱 WhatsApp: <strong>+254785103445</strong><br/>
      📧 Email: <a href="mailto:customercare@housika.co.ke">customercare@housika.co.ke</a>
    </p>
    <div class="footer">
      <p>Housika Properties is operated under Pansoft Technologies Kenya (BN-36S5WLAP).</p>
      <p>This message is confidential and intended for the recipient only.</p>
    </div>
  </div>
</body>
</html>
  `;
}
