import { Hono } from 'hono'
import { getUsers } from './get.js'
import { createUser } from './create.js'
import { updateUser } from './update.js'
import { getUserById } from './id.js'
import { deleteUser } from './delete.js'
// dashboard handler file you mentioned
import { getAdminStats } from './dashboard.js'

const usersRouter = new Hono()

// Users CRUD
usersRouter.get('/', getUsers)
usersRouter.post('/', createUser)
usersRouter.get('/:id', getUserById)
usersRouter.put('/:id', updateUser)
usersRouter.delete('/:id', deleteUser) // ✅ Delete user

// Admin/dashboard stats (kept under users route for convenience)
// - GET /users/dashboard  => returns admin stats (counts) as implemented in dashboard.js
// - also expose conventional admin path GET /users/admin/stats for backwards compatibility
usersRouter.get('/dashboard', getAdminStats)
usersRouter.get('/admin/stats', getAdminStats)

export default usersRouter
