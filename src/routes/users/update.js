import { getCollection } from '../../services/astra.js';
import { checkToken } from '../../utils/auth.js';

/**
 * PUT /users/:id
 * Updates a user document in the Astra DB "users" collection by ID.
 * Role updates are restricted:
 * - Only admin and ceo can update any role
 * - Customer care can only upgrade to: dual, landlord, real estate company
 * - No one can upgrade to ceo
 */
export const updateUser = async (c) => {
  const timestamp = new Date().toISOString();
  const targetId = c.req.param('id');
  const token = c.req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Missing token.', timestamp }, 401);
  }

  const actor = await checkToken(token).catch(err => {
    console.error('❌ Token check failed:', err.message || err);
    return null;
  });

  if (!actor) {
    return c.json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid token.', timestamp }, 401);
  }

  let updateData;
  try {
    updateData = await c.req.json();
    if (!updateData || typeof updateData !== 'object') throw new Error();
  } catch {
    return c.json({ success: false, error: 'INVALID_BODY', message: 'Request body must be valid JSON.', timestamp }, 400);
  }

  if (!targetId || typeof targetId !== 'string') {
    return c.json({ success: false, error: 'INVALID_USER_ID', message: 'User ID must be a string.', timestamp }, 400);
  }

  const usersCollection = await getCollection('users').catch(err => {
    console.error('❌ DB connection error:', err.message || err);
    return null;
  });

  if (!usersCollection?.find || !usersCollection?.patch) {
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

  // 🧠 Role enforcement
  const actorRole = actor.role;
  const newRole = updateData.role;
  if ('role' in updateData) {
    if (newRole === 'ceo') {
      return c.json({ success: false, error: 'ROLE_NOT_ALLOWED', message: 'Cannot upgrade to "ceo".', timestamp }, 403);
    }

    const allowedByCustomerCare = ['dual', 'landlord', 'real estate company'];
    if (actorRole === 'customer care' && !allowedByCustomerCare.includes(newRole)) {
      return c.json({ success: false, error: 'FORBIDDEN', message: 'Customer care can only upgrade to: dual, landlord, or real estate company.', timestamp }, 403);
    }

    if (!['admin', 'ceo', 'customer care'].includes(actorRole)) {
      return c.json({ success: false, error: 'FORBIDDEN', message: 'Insufficient role to update user.', timestamp }, 403);
    }
  }

  try {
    await usersCollection.patch(docId, {
      ...updateData,
      updated_by: actor.userId,
      updated_at: timestamp,
    });

    return c.json({
      success: true,
      message: 'User updated successfully.',
      updatedBy: actor.userId,
      timestamp,
    });
  } catch (err) {
    console.error('❌ Update failed:', err.message || err);
    return c.json({ success: false, error: 'UPDATE_FAILED', message: 'Failed to update user.', timestamp }, 500);
  }
};
