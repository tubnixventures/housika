import { Hono } from 'hono';

import { postContactMessage } from './post.js';
import { getContactMessages } from './get.js';
import { getContactMessageById } from './id.js';
import { replyToContactMessage } from './reply.js';
import { deleteOldReplies } from './delete.js';

const contactMessages = new Hono();

// --- Public Routes ---
// Submit a new contact message
contactMessages.post('/', postContactMessage);

// --- Admin / Customer Care Routes ---
// Inbox with filters + pagination
contactMessages.get('/', getContactMessages);

// View a single message by ID
contactMessages.get('/:id', getContactMessageById);

// Reply to a message
contactMessages.post('/reply', replyToContactMessage);

// Cleanup old replies (admin/ceo only)
contactMessages.delete('/', deleteOldReplies);

export default contactMessages;
