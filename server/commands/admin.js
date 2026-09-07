/**
 * Chequeo de admin de WhatsApp (Fase A2 — movido tal cual desde index.js).
 */

'use strict';

/** ¿El remitente es admin del bot? (el propio teléfono o WHATSAPP_ADMIN_JIDS). */
async function isAdminSender(ctx, senderId, msg) {
    if (msg?.fromMe) return true;
    if (!senderId) return false;
    const adminJids = (ctx.config.WHATSAPP_ADMIN_JIDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (adminJids.includes(senderId)) return true;
    if (!adminJids.length) return false;
    const [pair] = await ctx.whatsapp.resolveLidPn([senderId]);
    return [pair?.lid, pair?.pn].filter(Boolean).some(j => adminJids.includes(j));
}

module.exports = { isAdminSender };
