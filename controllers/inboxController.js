import { ContactMessage, Subscriber } from '../models/Inbox.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler, paginationMeta, parsePagination } from '../utils/helpers.js';

// POST /api/contact
export const sendContactMessage = asyncHandler(async (req, res) => {
    await ContactMessage.create(req.body);
    res.status(201).json({ success: true, message: 'Thanks! We will get back to you shortly.' });
});

// POST /api/newsletter — subscribing twice is not an error.
export const subscribe = asyncHandler(async (req, res) => {
    await Subscriber.updateOne({ email: req.body.email }, { $setOnInsert: { email: req.body.email } }, { upsert: true });
    res.status(201).json({ success: true, message: 'You are subscribed.' });
});

// GET /api/admin/messages
export const listMessages = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const [items, total, subscribers] = await Promise.all([
        ContactMessage.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
        ContactMessage.countDocuments(),
        Subscriber.countDocuments(),
    ]);
    res.json({ success: true, data: items, subscribers, pagination: paginationMeta(page, limit, total) });
});

// PATCH /api/admin/messages/:id
export const markMessage = asyncHandler(async (req, res) => {
    const msg = await ContactMessage.findByIdAndUpdate(req.params.id, { handled: Boolean(req.body?.handled) }, { new: true });
    if (!msg) throw ApiError.notFound('Message not found');
    res.json({ success: true, data: msg });
});
