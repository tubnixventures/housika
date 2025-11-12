import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getCollection } from '../../services/astra.js';
import { assignToken } from '../../utils/auth.js';
import { initZeptoMail } from '../../services/zeptoEmail.js';

const USERS_COLLECTION = 'users';
const ALLOWED_ROLES = ['landlord', 'dual', 'tenant']; // CEO permanently excluded

const register = async (c) => {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  try {
    const { email, password, phoneNumber, role } = await c.req.json();

    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      return c.json({ success: false, error: 'EMAIL_FORMAT_ERROR', message: 'Invalid email format.', timestamp }, 400);
    }

    if (password?.length < 8) {
      return c.json({ success: false, error: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.', timestamp }, 400);
    }

    if (!ALLOWED_ROLES.includes(role)) {
      return c.json({ success: false, error: 'INVALID_ROLE', message: `Role "${role}" is not permitted for registration.`, timestamp }, 403);
    }

    const usersCollection = await getCollection(USERS_COLLECTION);
    const [emailResult, phoneResult] = await Promise.all([
      usersCollection.find({ email: { $eq: normalizedEmail } }),
      phoneNumber ? usersCollection.find({ phonenumber: { $eq: phoneNumber } }) : Promise.resolve({ data: {} }),
    ]);

    const emailExists = Object.values(emailResult?.data || {})[0];
    const phoneExists = Object.values(phoneResult?.data || {})[0];

    if (emailExists) return c.json({ success: false, error: 'EMAIL_EXISTS', message: 'Email already registered.', timestamp }, 409);
    if (phoneExists) return c.json({ success: false, error: 'PHONE_EXISTS', message: 'Phone number already registered.', timestamp }, 409);

    const hashedPassword = await bcrypt.hash(password, 10);
    const auditMeta = {
      ip: c.req.header('x-forwarded-for') || c.req.header('host') || '',
      userAgent: c.req.header('user-agent') || '',
      traceId: crypto.randomUUID(),
    };

    const userId = crypto.randomUUID();
    const now = new Date();

    const newUser = {
      _id: userId,
      id: userId,
      email: normalizedEmail,
      password: hashedPassword,
      phonenumber: phoneNumber || null,
      role,
      status: 'UNCONFIRMED',
      emailverified: false,
      phoneverified: false,
      createdat: now,
      updatedat: now,
      logincount: 0,
      lastlogin: null,
      audit_ip: auditMeta.ip,
      audit_useragent: auditMeta.userAgent,
      audit_traceid: auditMeta.traceId,
      marketingoptin: false,
      notify_email: true,
      notify_sms: false,
    };

    await usersCollection.post(newUser);

    const token = await assignToken({ userId, email: normalizedEmail, role });

    c.header('Set-Cookie', `token=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);

    // 📧 Send welcome email
    try {
      const zepto = await initZeptoMail(c.env);
      const subject = `🎉 Welcome to Housika – Registered as ${role}`;
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
    <h2>Welcome to Housika!</h2>
    <p>Hi there,</p>
    <p>Your account has been successfully registered as a <strong>${role}</strong>.</p>
    <p>We’re thrilled to have you on board. Let’s build something great together.</p>
    <div class="footer">
      <p>Housika Properties is a platform operated under Pansoft Technologies Kenya.</p>
      <p>For support, contact <a href="mailto:customercare@housika.co.ke">customercare@housika.co.ke</a></p>
    </div>
  </div>
</body>
</html>
      `;

      await zepto.sendCustomerCareReply({
        to: normalizedEmail,
        subject,
        htmlbody,
        recipientName: normalizedEmail,
      });
    } catch (err) {
      console.error('❌ Welcome email failed:', err.message || err);
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Registration completed in ${duration}ms for ${normalizedEmail}`);

    return c.json({
      success: true,
      message: 'Registration successful.',
      userId,
      role,
      token,
      timestamp,
    }, 201);
  } catch (error) {
    console.error('🔥 Unexpected registration error:', error.message || error);
    return c.json({
      success: false,
      error: 'UNEXPECTED_ERROR',
      message: 'Unexpected server error.',
      timestamp,
    }, 500);
  }
};

export default register;
