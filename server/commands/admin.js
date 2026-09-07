/**
 * Chequeo de admin de WhatsApp (Fase A2 — movido tal cual desde index.js;
 * Fase A3 — reescrito sobre Identity en vez de comparar JIDs crudos, ver
 * server/messaging/jid.js. El comportamiento observable es el mismo: admin
 * si el mensaje es del propio bot (fromMe), o si el remitente (en
 * cualquiera de sus formas conocidas, teléfono o LID) está en
 * WHATSAPP_ADMIN_JIDS / WHATSAPP_ADMIN_IDS.
 *
 * `WHATSAPP_ADMINS_FROM_GROUP=true` agrega una segunda fuente: los admins
 * del grupo de WhatsApp de origen (según la propia app), cacheados 10 min
 * para no golpear getGroupParticipants() en cada comando.
 */

'use strict';

const { parseIdList, identityFromJid, sameIdentity, mergeIdentity } = require('../messaging/jid');

const GROUP_ADMIN_CACHE_MS = 10 * 60 * 1000;
const groupAdminCache = new Map(); // format -> { at, identities }

function configuredAdmins(config) {
    const raw = [config?.WHATSAPP_ADMIN_JIDS, config?.WHATSAPP_ADMIN_IDS].filter(Boolean).join(',');
    return parseIdList(raw);
}

async function getGroupAdminIdentities(ctx, format) {
    const cached = groupAdminCache.get(format);
    const now = Date.now();
    if (cached && now - cached.at < GROUP_ADMIN_CACHE_MS) return cached.identities;

    let identities = [];
    try {
        const participants = await ctx.whatsapp.getGroupParticipants(format);
        identities = (participants || [])
            .filter(p => p?.isAdmin)
            .map(p => p.identity || identityFromJid(p.jid));
    } catch { /* best effort: getGroupParticipants no está garantizado */ }

    groupAdminCache.set(format, { at: now, identities });
    return identities;
}

/**
 * ¿El remitente es admin del bot?
 * @param {object} ctx
 * @param {string} senderId - JID de quien mandó el comando
 * @param {object} msg - mensaje nativo (msg.fromMe === true si lo mandó el bot)
 * @param {string} [format] - formato del grupo de origen, solo para
 *   WHATSAPP_ADMINS_FROM_GROUP (opcional: sin él, esa fuente se salta).
 */
async function isAdminSender(ctx, senderId, msg, format) {
    if (msg?.fromMe) return true;
    if (!senderId) return false;

    const admins = configuredAdmins(ctx.config);
    const senderIdentity = identityFromJid(senderId);
    if (admins.some(a => sameIdentity(a, senderIdentity))) return true;

    let altIdentity = {};
    if (admins.length && typeof ctx.whatsapp?.resolveLidPn === 'function') {
        const [pair] = await ctx.whatsapp.resolveLidPn([senderId]);
        altIdentity = mergeIdentity(identityFromJid(pair?.lid), identityFromJid(pair?.pn));
        if (admins.some(a => sameIdentity(a, altIdentity))) return true;
    }

    if (ctx.config?.WHATSAPP_ADMINS_FROM_GROUP && format && typeof ctx.whatsapp?.getGroupParticipants === 'function') {
        const groupAdmins = await getGroupAdminIdentities(ctx, format);
        if (groupAdmins.some(g => sameIdentity(g, senderIdentity) || sameIdentity(g, altIdentity))) return true;
    }

    return false;
}

module.exports = { isAdminSender, _resetGroupAdminCacheForTests: () => groupAdminCache.clear() };
