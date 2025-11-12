import pkg from 'jsonwebtoken';
const { sign, verify } = pkg;

import { Redis } from '@upstash/redis';

const JWT_SECRET = process.env.JWT_SECRET || 'your_very_secret_key_change_me';
const JWT_EXPIRATION = process.env.JWT_EXPIRATION || '7d';

const redis = new Redis({
  url: 'https://gorgeous-ghoul-15689.upstash.io',
  token: 'AT1JAAIncDJmNWUzYWI1Y2M2ZTY0NzA0YWFiYmJjMmUxMmU5MjM0MXAyMTU2ODk',
});

const getRedisTTL = (exp = JWT_EXPIRATION) => {
  const [, val, unit] = exp.match(/^(\d+)([smhd])$/) || [];
  const n = parseInt(val);
  return unit === 's' ? n : unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : unit === 'd' ? n * 86400 : 604800;
};

const assignToken = async ({ userId, email, role }) => {
  const token = sign({ userId, email, role }, JWT_SECRET, { expiresIn: JWT_EXPIRATION });
  await redis.set(`auth:${userId}:${token}`, 'active', { ex: getRedisTTL() });
  return token;
};

const checkToken = async (token) => {
  if (!token) return null;
  try {
    const payload = verify(token, JWT_SECRET);
    const exists = await redis.get(`auth:${payload.userId}:${token}`);
    return exists ? payload : null;
  } catch {
    return null;
  }
};

const deleteToken = async (userId, token) => redis.del(`auth:${userId}:${token}`);

const deleteAllTokens = async (userId) => {
  const keys = await redis.keys(`auth:${userId}:*`);
  if (keys.length) await redis.del(...keys);
};

const roleCheck = (payload, required) =>
  !!payload?.role && (Array.isArray(required) ? required : [required]).includes(payload.role);

export {
  assignToken,
  checkToken,
  deleteToken,
  deleteAllTokens,
  roleCheck,
  redis,
};
