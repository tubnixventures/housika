import pkg from 'jsonwebtoken';
const { sign, verify } = pkg;

import { Redis } from '@upstash/redis';

const JWT_SECRET = process.env.JWT_SECRET || 'your_very_secret_key_change_me';
const JWT_EXPIRATION = process.env.JWT_EXPIRATION || '7d';

const redis = new Redis({
  url: 'https://gorgeous-ghoul-15689.upstash.io',
  token: 'AT1JAAIncDJmNWUzYWI1Y2M2ZTY0NzA0YWFiYmJjMmUxMmU5MjM0MXAyMTU2ODk',
})

/**
 * Converts JWT_EXPIRATION to seconds for Redis TTL
 */
function getRedisTTL(expiration = JWT_EXPIRATION) {
  const match = expiration.match(/^(\d+)([smhd])$/);
  if (!match) return 604800;

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return 604800;
  }
}

/**
 * Assigns a JWT and stores it in Redis with TTL
 */
async function assignToken(payload) {
  const token = sign(
    {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRATION }
  );

  const redisKey = `auth:${payload.userId}:${token}`;
  const ttl = getRedisTTL(JWT_EXPIRATION);

  await redis.set(redisKey, 'active', { ex: ttl });

  return token;
}

/**
 * Verifies JWT and checks Redis for session validity
 */
async function checkToken(token) {
  if (!token) return null;

  try {
    const payload = verify(token, JWT_SECRET);
    const redisKey = `auth:${payload.userId}:${token}`;
    const exists = await redis.get(redisKey);

    return exists ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Deletes a specific token from Redis (logout)
 */
async function deleteToken(userId, token) {
  const redisKey = `auth:${userId}:${token}`;
  await redis.del(redisKey);
}

/**
 * Deletes all tokens for a user (multi-session logout)
 */
async function deleteAllTokens(userId) {
  const keys = await redis.keys(`auth:${userId}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

/**
 * Role check utility
 */
function roleCheck(payload, requiredRoles) {
  if (!payload?.role) return false;
  const roles = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
  return roles.includes(payload.role);
}

export {
  assignToken,
  checkToken,
  deleteToken,
  deleteAllTokens,
  roleCheck,
  redis,
};
