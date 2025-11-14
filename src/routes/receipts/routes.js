import { Hono } from 'hono';
import verify  from './verify.js';
import  receipts  from './post.js';
import list from './list.js';
import mine from './mine/[receipt_id].js';


const rooms = new Hono();

rooms.get('/verify', verify);                  
rooms.put('/:id', mine); 
rooms.delete('/list', list);
rooms.post('/', receipts); 

export default receiptRoutes;
