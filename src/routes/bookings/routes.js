// routes.js
import { Hono } from 'hono';
import postBooking from './post.js';
import getBookings from './get.js';
import getBookingById from './id.js';
import { updateBooking } from './update.js';

const bookingsRoutes = new Hono();

// Single booking (must come before the collection route to avoid collisions)
bookingsRoutes.get('/:id', getBookingById); // Get a single booking by ID

// Collection routes
bookingsRoutes.post('/', postBooking);       // Create a new booking
bookingsRoutes.get('/', getBookings);        // Get bookings (paginated / role-aware)
bookingsRoutes.put('/:id', updateBooking);   // Update booking by ID (landlord/admin/ceo)

export default bookingsRoutes;
