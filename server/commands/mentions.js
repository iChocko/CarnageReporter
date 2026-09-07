/**
 * Resolución de menciones de WhatsApp <-> gamertags del roster (Fase A2 —
 * movido tal cual desde index.js, salvo que ahora recibe `ctx` en vez de
 * cerrar sobre variables de módulo).
 */

'use strict';

const rosterStore = require('../utils/roster');
const { sanitizeCaptionText } = require('../utils/matchSummary');
const { aggregatePlayers } = require('../utils/records');
const { identityFromJid } = require('../messaging/jid');

const MAX_TAG_LEN = 32;         // los gamertags de Xbox no pasan de ~16; techo holgado
const MAX_MENTION_TARGETS = 20; // techo duro de menciones; validateRoster ya limita a 16

/**
 * Últimos 4 dígitos de un JID o de una clave de Identity ('pn:521...',
 * 'lid:1234'), o '' si no hay dígitos. Genérico: no le importa el formato
 * de entrada, solo extrae dígitos.
 */
function jidDigits(jidOrKey) {
    const digits = (String(jidOrKey || '').match(/\d{4,}/) || [])[0] || '';
    return digits.slice(-4);
}

/**
 * Resuelve los JIDs mencionados a gamertags vía el roster persistente.
 * Aprende la forma alterna de JID (LID/teléfono) cuando el puente responde,
 * con UNA sola llamada al puente para todos los faltantes.
 * @returns {{tags: string[], unresolvedDisplays: string[], botMentioned: boolean}}
 */
async function resolveMentionsToTags(ctx, mentionedIds) {
    const { whatsapp, outputDir, locks } = ctx;
    const own = whatsapp.getOwnIds();
    const seen = new Set();
    const jids = [];
    let botMentioned = false;
    for (const jid of mentionedIds || []) {
        if (own.has(jid)) { botMentioned = true; continue; }
        if (!seen.has(jid)) { seen.add(jid); jids.push(jid); }
    }

    const { linkByJid, pairByJid } = await locks.withRosterLock(async () => {
        const data = rosterStore.loadRoster(outputDir);
        const found = new Map();
        const misses = [];
        for (const jid of jids) {
            const link = rosterStore.findByJid(data, jid);
            if (link) found.set(jid, link);
            else misses.push(jid);
        }
        const pairs = new Map();
        if (misses.length) {
            // La persona puede estar registrada con la otra forma de JID
            const resolved = await whatsapp.resolveLidPn(misses);
            let learned = false;
            misses.forEach((jid, i) => {
                const pair = resolved[i] || {};
                pairs.set(jid, pair);
                for (const alt of [pair.lid, pair.pn].filter(Boolean)) {
                    const link = rosterStore.findByJid(data, alt);
                    if (link) { rosterStore.addAlias(link, jid); found.set(jid, link); learned = true; break; }
                }
            });
            if (learned) rosterStore.saveRoster(outputDir, data);
        }
        return { linkByJid: found, pairByJid: pairs };
    });

    const tags = [];
    const unresolved = [];
    const jidByTagLower = new Map(); // para que la respuesta mencione de vuelta
    for (const jid of jids) {
        const link = linkByJid.get(jid);
        if (link) {
            tags.push(link.gamertag);
            jidByTagLower.set(link.gamertag.toLowerCase(), jid);
        } else {
            unresolved.push(jid);
        }
    }

    // Nombre visible de los no registrados (best effort; nunca tumba el comando).
    // OJO: si la mención llegó como @lid, WhatsApp Web no siempre trae el
    // pushname para esa forma — se prefiere la forma @c.us (del puente
    // LID↔teléfono ya resuelto arriba), que sí lo trae de forma confiable.
    let unresolvedDisplays = [];
    if (unresolved.length) {
        unresolvedDisplays = await Promise.all(unresolved.map(async jid => {
            const phoneForm = pairByJid.get(jid)?.pn || (identityFromJid(jid).pn ? jid : null);
            const info = await whatsapp.getContactInfo(phoneForm || jid);
            const digits = jidDigits(phoneForm || jid);
            const nombre = sanitizeCaptionText(info.pushname || info.name || '');
            if (nombre && digits) return `${nombre} (…${digits})`;
            if (nombre) return nombre;
            return digits ? `…${digits}` : 'un contacto';
        }));
    }

    return { tags, unresolvedDisplays, botMentioned, jidByTagLower };
}

/**
 * Índice de gamertags conocidos en TODAS las partidas (ambos formatos), para
 * validar registros del roster: lower -> canónico, y partidas por tag.
 */
async function getKnownTagIndex(ctx) {
    const [g2, g4] = await Promise.all([
        ctx.gamesCache.getAllValidGamesWithPlayers('2v2'),
        ctx.gamesCache.getAllValidGamesWithPlayers('4v4')
    ]);
    const knownByLower = new Map();
    const gamesByLower = new Map();
    for (const games of [g4, g2]) { // 2v2 al final: tiene prioridad en el nombre canónico
        for (const p of aggregatePlayers(games)) {
            const lower = p.gamertag.toLowerCase();
            knownByLower.set(lower, p.gamertag);
            gamesByLower.set(lower, (gamesByLower.get(lower) || 0) + p.total_games);
        }
    }
    return { knownByLower, gamesByLower };
}

/**
 * Vincula un JID a un gamertag guardando sus dos formas (LID y teléfono).
 * Resuelve las formas ANTES de vincular: si la persona ya está registrada con
 * su otra forma de JID, se cura el alias en lugar de declarar un conflicto
 * falso ("ya está registrado con otro número") o crear un vínculo duplicado.
 * Llamar siempre dentro de locks.withRosterLock.
 */
async function linkWithAliases(ctx, data, jid, gamertag, opts) {
    const [pair] = await ctx.whatsapp.resolveLidPn([jid]);
    const forms = [...new Set([jid, pair?.lid, pair?.pn].filter(Boolean))];
    for (const form of forms) {
        const existing = rosterStore.findByJid(data, form);
        if (existing) { forms.forEach(f => rosterStore.addAlias(existing, f)); break; }
    }
    const result = rosterStore.linkJid(data, jid, gamertag, opts);
    if (result.ok) {
        forms.forEach(f => rosterStore.addAlias(result.link, f));
        rosterStore.saveRoster(ctx.outputDir, data);
    }
    return result;
}

/** Gamertag del remitente según el roster (probando ambas formas de JID). */
async function resolveSenderTag(ctx, senderId) {
    if (!senderId) return null;
    const data = rosterStore.loadRoster(ctx.outputDir);
    let link = rosterStore.findByJid(data, senderId);
    if (!link) {
        const [pair] = await ctx.whatsapp.resolveLidPn([senderId]);
        for (const alt of [pair?.lid, pair?.pn].filter(Boolean)) {
            link = rosterStore.findByJid(data, alt);
            if (link) break;
        }
    }
    return link ? link.gamertag : null;
}

module.exports = {
    resolveMentionsToTags, getKnownTagIndex, linkWithAliases, resolveSenderTag,
    jidDigits, MAX_TAG_LEN, MAX_MENTION_TARGETS,
};
