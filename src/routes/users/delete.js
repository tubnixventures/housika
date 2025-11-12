import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

/**
 * DELETE /users/:id
 * Deletes a user document from the Astra DB "users" collection by ID.
 * Only superior roles can delete junior roles.
 */
export const deleteUser = async (c) => {
  const timestamp = new Date().toISOString();
  const targetId = c.req.param('id');
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Missing token.', timestamp }, 401);
  }

  const actor = await checkToken(token).catch(err => {
    console.error('❌ Token validation failed:', err.message || err);
    return null;
  });

  if (!actor) {
    return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid token.', timestamp }, 401);
  }

  if (!targetId || typeof targetId !== 'string') {
    return c.json({ success: false, error: 'INVALID_USER_ID', message: 'User ID must be a string.', timestamp }, 400);
  }

  const usersCollection = await getCollection('users').catch(err => {
    console.error('❌ DB connection error:', err.message || err);
    return null;
  });

  if (!usersCollection?.find || !usersCollection?.delete) {
    return c.json({ success: false, error: 'DB_CONNECTION_FAILED', message: 'Invalid users collection.', timestamp }, 503);
  }

  const result = await usersCollection.find({ _id: targetId }).catch(err => {
    console.error('❌ User lookup failed:', err.message || err);
    return null;
  });

  const entries = Object.entries(result?.data || {});
  if (entries.length === 0) {
    return c.json({ success: false, error: 'USER_NOT_FOUND', message: `No user found with ID "${targetId}".`, timestamp }, 404);
  }

  const [docId, targetUser] = entries[0];

  // 🧠 Role hierarchy enforcement
  const hierarchy = ['landlord', 'dual', 'customer care', 'admin', 'ceo'];
  const actorRank = hierarchy.indexOf(actor.role);
  const targetRank = hierarchy.indexOf(targetUser.role);

  if (actorRank === -1 || targetRank === -1) {
    return c.json({ success: false, error: 'ROLE_UNKNOWN', message: 'One or both roles are unrecognized.', timestamp }, 400);
  }

  if (actorRank <= targetRank) {
    return c.json({ success: false, error: 'FORBIDDEN', message: 'Cannot delete user with equal or higher role.', timestamp }, 403);
  }

  try {
    await usersCollection.delete(docId);
    return c.json({
      success: true,
      message: 'User deleted successfully.',
      deletedBy: actor.userId,
      timestamp,
    });
  } catch (err) {
    console.error('❌ Deletion failed:', err.message || err);
    return c.json({ success: false, error: 'DELETE_FAILED', message: 'Failed to delete user.', timestamp }, 500);
  }
};
