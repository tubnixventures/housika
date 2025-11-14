import { Hono } from 'hono';
import { createChat } from './create.js';
import { getChats } from './get.js';
import { getMessagesForChat } from './id.js';
import { postMessageToChat } from './messages.post.js';

const chats = new Hono();

// Create a new chat
chats.post('/', createChat);

// Get all chats (for chat listing screen)
chats.get('/', getChats);

// Get messages for a specific chat (for chatroom screen)
chats.get('/:id', getMessagesForChat);

// Post a new message to a specific chat (chatroom)
chats.post('/:id/messages', postMessageToChat);

const chatsRoutes = chats;
export default chatsRoutes;
