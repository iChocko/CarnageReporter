/**
 * Roster de WhatsApp: mapeo persistente identidad ↔ gamertag.
 *
 * Cuando alguien etiqueta en el grupo, el bot no ve nombres: recibe JIDs
 * (número `521...@c.us` o su forma nueva `...@lid`). Este módulo traduce
 * esos JIDs al gamertag con el que la persona aparece en las partidas.
 *
 * Fase A3: el vínculo ya no guarda JIDs crudos (`jids: [...]`) sino
 * `ids: ['pn:521...', 'lid:1234']` — claves de Identity (ver
 * server/messaging/jid.js), transporte-neutrales y sin sufijo ni
 * `:device`. `loadRoster` migra archivos v1 (`jids`) a v2 (`ids`) al leer,
 * de forma idempotente: un archivo ya v2 pasa sin cambios, y volver a
 * migrar un archivo recién migrado da exactamente el mismo resultado. Esto
 * es clave porque el roster de prod (grupo Retas H3) viene sembrado con
 * LIDs reales que NO se deben perder ni duplicar en la migración.
 *
 * `known:false` marca gamertags que aún no han aparecido en ninguna
 * partida (jugador nuevo → rating provisional).
 *
 * Se persiste como JSON en OUTPUT_DIR (volumen montado: sobrevive
 * redeploys sin tocar el esquema de la base), igual que rondasReset.js.
 */

'use strict';

const path = require('path');
const { readJson, writeJsonAtomic } = require('../state/jsonStore');
const { identityFromJid, identityKeys } = require('../messaging/jid');

const ROSTER_FILE = 'whatsapp_roster.json';
const ID_KEY_RE = /^(pn|lid):\d+$/;

function rosterFilePath(dir) {
    return path.join(dir, ROSTER_FILE);
}

const normTag = s => String(s || '').trim().replace(/\s+/g, ' ');
const lowerTag = s => normTag(s).toLowerCase();

/**
 * Normaliza cualquier forma de entrada a un array de claves de Identity:
 * - ya es una clave ('pn:521...', 'lid:1234') -> se queda igual
 * - es un objeto Identity ({pn,lid}) -> identityKeys(x)
 * - es un JID crudo ('521...@c.us', '1234@lid') -> se traduce
 * Entradas sin dígitos reconocibles se descartan silenciosamente.
 */
function toKeys(x) {
    if (!x) return [];
    if (typeof x === 'object') return identityKeys(x);
    const s = String(x);
    if (ID_KEY_RE.test(s)) return [s];
    return identityKeys(identityFromJid(s));
}

function emptyRoster() {
    return { version: 2, links: [] };
}

/** Migra un link v1 (`jids`) o ya v2 (`ids`) a la forma v2 canónica; null si es inválido. */
function migrateLink(l) {
    if (!l || !l.gamertag) return null;
    let ids;
    if (Array.isArray(l.ids)) {
        ids = l.ids.filter(k => ID_KEY_RE.test(String(k)));
    } else if (Array.isArray(l.jids)) {
        ids = l.jids.flatMap(toKeys);
    } else {
        return null;
    }
    ids = [...new Set(ids)];
    if (!ids.length) return null;

    return {
        gamertag: normTag(l.gamertag),
        ids,
        known: !!l.known,
        linkedAt: l.linkedAt || new Date().toISOString(),
        linkedBy: l.linkedBy || 'migration',
    };
}

/** Carga el roster; tolerante a archivo faltante o corrupto (roster vacío). Migra v1 -> v2 al vuelo. */
function loadRoster(dir) {
    const data = readJson(rosterFilePath(dir), null);
    if (!data || !Array.isArray(data.links)) return emptyRoster();
    const links = data.links.map(migrateLink).filter(Boolean);
    return { version: 2, links };
}

/** Guarda el roster con escritura atómica (tmp + fsync + rename). Siempre en forma v2. */
function saveRoster(dir, roster) {
    writeJsonAtomic(rosterFilePath(dir), { version: 2, links: roster.links });
}

/** Busca el vínculo que tenga alguna de estas claves de Identity. */
function findByKeys(roster, keys) {
    if (!keys?.length) return null;
    return roster.links.find(l => Array.isArray(l.ids) && l.ids.some(k => keys.includes(k))) || null;
}

/** Busca el vínculo de una Identity ({pn?, lid?}). */
function findByIdentity(roster, identity) {
    return findByKeys(roster, identityKeys(identity));
}

/** Shim de compatibilidad: busca por JID crudo, vía identityFromJid. */
function findByJid(roster, jid) {
    return findByKeys(roster, toKeys(jid));
}

/** Busca por gamertag (case-insensitive). */
function findByGamertag(roster, tag) {
    const key = lowerTag(tag);
    if (!key) return null;
    return roster.links.find(l => lowerTag(l.gamertag) === key) || null;
}

/**
 * Vincula una identidad (JID crudo, Identity, o clave ya normalizada) a un
 * gamertag.
 * - Misma identidad ya vinculada a otro tag → sobrescribe (devuelve `previous`).
 * - Tag ya reclamado por OTRA identidad → conflicto (no toca nada).
 * @returns {{ok:boolean, link?:object, previous?:string, conflict?:object}}
 */
function linkJid(roster, idOrJid, gamertag, { known = false, by = 'admin' } = {}) {
    const tag = normTag(gamertag);
    const keys = toKeys(idOrJid);
    if (!keys.length || !tag) return { ok: false };

    const claimed = findByGamertag(roster, tag);
    if (claimed && !keys.some(k => claimed.ids.includes(k))) {
        return { ok: false, conflict: claimed };
    }

    const existing = findByKeys(roster, keys);
    if (existing) {
        const previous = existing.gamertag;
        existing.gamertag = tag;
        existing.known = known;
        existing.linkedAt = new Date().toISOString();
        existing.linkedBy = by;
        keys.forEach(k => { if (!existing.ids.includes(k)) existing.ids.push(k); });
        return { ok: true, link: existing, previous: lowerTag(previous) !== lowerTag(tag) ? previous : undefined };
    }

    const link = { ids: [...keys], gamertag: tag, known, linkedAt: new Date().toISOString(), linkedBy: by };
    roster.links.push(link);
    return { ok: true, link };
}

/** Agrega una forma alterna de identidad (JID, Identity o clave) al vínculo si no la tiene. */
function addAlias(link, idOrJid) {
    for (const k of toKeys(idOrJid)) {
        if (!link.ids.includes(k)) link.ids.push(k);
    }
}

/** Quita un gamertag del roster. */
function unlinkGamertag(roster, tag) {
    const key = lowerTag(tag);
    const idx = roster.links.findIndex(l => lowerTag(l.gamertag) === key);
    if (idx === -1) return false;
    roster.links.splice(idx, 1);
    return true;
}

/** Distancia de Levenshtein (para sugerir el gamertag ante un typo). */
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const curr = [i];
        for (let j = 1; j <= n; j++) {
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        prev = curr;
    }
    return prev[n];
}

/**
 * Casa lo que escribió la persona contra los gamertags conocidos.
 * @param {string} input
 * @param {Map<string,string>} knownByLower - gamertagLower -> gamertag canónico
 * @returns {{exact?:string, suggestion?:string, unknown?:true}}
 */
function matchGamertag(input, knownByLower) {
    const key = lowerTag(input);
    // Entradas absurdas de largas ni se comparan (Levenshtein es O(n·m))
    if (!key || key.length > 40) return { unknown: true };
    if (knownByLower.has(key)) return { exact: knownByLower.get(key) };

    let best = null, bestDist = Infinity;
    for (const [lower, canon] of knownByLower) {
        if (lower.includes(key) || key.includes(lower)) {
            const dist = Math.abs(lower.length - key.length);
            if (dist < bestDist) { best = canon; bestDist = dist; }
            continue;
        }
        const dist = levenshtein(key, lower);
        if (dist <= 2 && dist < bestDist) { best = canon; bestDist = dist; }
    }
    if (best) return { suggestion: best };
    return { unknown: true };
}

module.exports = {
    loadRoster, saveRoster, findByJid, findByIdentity, findByGamertag,
    linkJid, addAlias, unlinkGamertag, matchGamertag, levenshtein,
    ROSTER_FILE
};
