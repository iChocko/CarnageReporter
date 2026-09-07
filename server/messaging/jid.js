/**
 * Identidad transporte-neutral (Fase A3).
 *
 * WhatsApp identifica a una persona con un JID (`521...@c.us`, su forma
 * nueva `...@lid`, o `...@s.whatsapp.net`), y la misma persona puede
 * aparecer con más de una forma según el momento (WhatsApp está migrando
 * de teléfono a LID). Este módulo reduce cualquiera de esas formas a un
 * `Identity` simple — `{ pn?: string, lid?: string }`, ambos SOLO dígitos,
 * sin sufijo `@...` ni `:device` — para que el resto del código (roster,
 * comandos, adaptadores) compare identidades sin conocer el formato de
 * ningún transporte en particular.
 *
 * `Identity` es intencionalmente parcial: puede traer `pn`, `lid`, ambos, o
 * ninguno (identidad vacía/no reconocida). Dos identidades son "la misma
 * persona" (`sameIdentity`) si comparten al menos un campo no vacío.
 */

'use strict';

const LID_SUFFIX = '@lid';
const PN_SUFFIXES = ['@c.us', '@s.whatsapp.net'];

/** Solo dígitos de un string arbitrario (o '' si no hay). */
function onlyDigits(s) {
    return String(s === null || s === undefined ? '' : s).replace(/\D/g, '');
}

/** Quita un sufijo ":device" (ej. "1234:5" -> "1234"). */
function stripDevice(userPart) {
    return String(userPart).split(':')[0];
}

/**
 * Convierte un JID (o número plano) a `Identity`.
 * Acepta: `521...@c.us`, `521...@s.whatsapp.net`, `1234@lid`, `1234:5@lid`,
 * dígitos sueltos (se tratan como `pn`). Cualquier otra cosa -> `{}`.
 * @param {string|null|undefined} jid
 * @returns {{pn?: string, lid?: string}}
 */
function identityFromJid(jid) {
    if (jid === null || jid === undefined) return {};
    const raw = String(jid).trim();
    if (!raw) return {};

    if (raw.endsWith(LID_SUFFIX)) {
        const digits = onlyDigits(stripDevice(raw.slice(0, -LID_SUFFIX.length)));
        return digits ? { lid: digits } : {};
    }

    for (const suffix of PN_SUFFIXES) {
        if (raw.endsWith(suffix)) {
            const digits = onlyDigits(stripDevice(raw.slice(0, -suffix.length)));
            return digits ? { pn: digits } : {};
        }
    }

    // Sin sufijo @: dígitos sueltos (p.ej. WHATSAPP_ADMIN_JIDS mal capturado,
    // o un número tecleado a mano) se tratan como número de teléfono.
    const digits = onlyDigits(stripDevice(raw));
    return digits ? { pn: digits } : {};
}

/**
 * Claves estables de una identidad, para usarlas como llave de mapa/roster.
 * Orden fijo (pn, lid) para que el mismo Identity siempre produzca el mismo
 * array (comparable con deepStrictEqual en tests).
 * @param {{pn?: string, lid?: string}} identity
 * @returns {string[]} p.ej. ['pn:521...', 'lid:1234']
 */
function identityKeys(identity) {
    const keys = [];
    if (identity?.pn) keys.push(`pn:${identity.pn}`);
    if (identity?.lid) keys.push(`lid:${identity.lid}`);
    return keys;
}

/** Inverso de identityKeys: ['pn:521...','lid:1234'] -> {pn,lid}. Ignora claves con forma inválida. */
function identityFromKeys(keys) {
    const identity = {};
    for (const k of keys || []) {
        const m = /^(pn|lid):(\d+)$/.exec(String(k));
        if (m) identity[m[1]] = m[2];
    }
    return identity;
}

/** ¿`a` y `b` son la misma persona? (comparten al menos una clave no vacía). */
function sameIdentity(a, b) {
    const keysA = identityKeys(a);
    if (!keysA.length) return false;
    const keysB = new Set(identityKeys(b));
    return keysA.some(k => keysB.has(k));
}

/** Combina dos identidades (parciales) de la misma persona; `a` tiene prioridad. */
function mergeIdentity(a, b) {
    const out = {};
    const pn = a?.pn || b?.pn;
    const lid = a?.lid || b?.lid;
    if (pn) out.pn = pn;
    if (lid) out.lid = lid;
    return out;
}

/**
 * Parte "usuario" de un JID para construir tokens de mención "@<dígitos>"
 * (lo que WhatsApp espera dentro del texto). Es simplemente los dígitos de
 * la identidad (pn o, si no hay, lid), sin sufijo ni ":device".
 * @param {string} jid
 * @returns {string} p.ej. "5215500000000" o "" si no se reconoce
 */
function mentionUserPart(jid) {
    const id = identityFromJid(jid);
    return id.pn || id.lid || '';
}

/**
 * Reconstruye un JID "clásico" (`@c.us`/`@lid`) a partir de una identidad.
 * No es parte del contrato transporte-neutral, pero varios llamadores viejos
 * (envíos reales de WhatsApp, roster heredado) todavía necesitan un JID
 * completo, no solo dígitos. Prioriza `pn` (forma con más metadata en
 * whatsapp-web.js, p.ej. pushname) y cae a `lid` si no hay teléfono.
 * @param {{pn?: string, lid?: string}} identity
 * @returns {string|null}
 */
function toLegacyJid(identity) {
    if (identity?.pn) return `${identity.pn}@c.us`;
    if (identity?.lid) return `${identity.lid}@lid`;
    return null;
}

/**
 * Parsea una lista separada por comas de JIDs (formato histórico de
 * WHATSAPP_ADMIN_JIDS: "521...@c.us,1234@lid") a Identity[].
 * @param {string} envString
 * @returns {Array<{pn?: string, lid?: string}>}
 */
function parseIdList(envString) {
    return String(envString || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(identityFromJid)
        .filter(id => id.pn || id.lid);
}

module.exports = {
    identityFromJid,
    identityKeys,
    identityFromKeys,
    sameIdentity,
    mergeIdentity,
    mentionUserPart,
    toLegacyJid,
    parseIdList,
};
