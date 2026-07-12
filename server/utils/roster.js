/**
 * Roster de WhatsApp: mapeo persistente ID de WhatsApp (JID) ↔ gamertag.
 *
 * Cuando alguien etiqueta en el grupo, el bot no ve nombres: recibe JIDs
 * (número `521...@c.us` o su forma nueva `...@lid`). Este módulo traduce
 * esos JIDs al gamertag con el que la persona aparece en las partidas.
 *
 * Cada vínculo guarda TODAS las formas de JID conocidas de la persona
 * (WhatsApp está migrando a LIDs y la misma persona puede llegar con
 * cualquiera de las dos), y `known:false` marca gamertags que aún no han
 * aparecido en ninguna partida (jugador nuevo → rating provisional).
 *
 * Se persiste como JSON en OUTPUT_DIR (volumen montado: sobrevive
 * redeploys sin tocar el esquema de la base), igual que rondasReset.js.
 */

const fs = require('fs');
const path = require('path');

const ROSTER_FILE = 'whatsapp_roster.json';

function rosterFilePath(dir) {
    return path.join(dir, ROSTER_FILE);
}

const normTag = s => String(s || '').trim().replace(/\s+/g, ' ');
const lowerTag = s => normTag(s).toLowerCase();

function emptyRoster() {
    return { version: 1, links: [] };
}

/** Carga el roster; tolerante a archivo faltante o corrupto (roster vacío). */
function loadRoster(dir) {
    try {
        const data = JSON.parse(fs.readFileSync(rosterFilePath(dir), 'utf-8'));
        if (!data || !Array.isArray(data.links)) return emptyRoster();
        return { version: data.version || 1, links: data.links.filter(l => l && Array.isArray(l.jids) && l.gamertag) };
    } catch (e) {
        return emptyRoster();
    }
}

/** Guarda el roster con escritura atómica (tmp + rename). */
function saveRoster(dir, roster) {
    const file = rosterFilePath(dir);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(roster, null, 2));
    fs.renameSync(tmp, file);
}

/** Busca el vínculo que contenga este JID exacto. */
function findByJid(roster, jid) {
    if (!jid) return null;
    return roster.links.find(l => l.jids.includes(jid)) || null;
}

/** Busca por gamertag (case-insensitive). */
function findByGamertag(roster, tag) {
    const key = lowerTag(tag);
    if (!key) return null;
    return roster.links.find(l => lowerTag(l.gamertag) === key) || null;
}

/**
 * Vincula un JID a un gamertag.
 * - Mismo JID ya vinculado a otro tag → sobrescribe (devuelve `previous`).
 * - Tag ya reclamado por OTRO JID → conflicto (no toca nada).
 * @returns {{ok:boolean, link?:object, previous?:string, conflict?:object}}
 */
function linkJid(roster, jid, gamertag, { known = false, by = 'admin' } = {}) {
    const tag = normTag(gamertag);
    if (!jid || !tag) return { ok: false };

    const claimed = findByGamertag(roster, tag);
    if (claimed && !claimed.jids.includes(jid)) {
        return { ok: false, conflict: claimed };
    }

    const existing = findByJid(roster, jid);
    if (existing) {
        const previous = existing.gamertag;
        existing.gamertag = tag;
        existing.known = known;
        existing.linkedAt = new Date().toISOString();
        existing.linkedBy = by;
        return { ok: true, link: existing, previous: lowerTag(previous) !== lowerTag(tag) ? previous : undefined };
    }

    const link = { jids: [jid], gamertag: tag, known, linkedAt: new Date().toISOString(), linkedBy: by };
    roster.links.push(link);
    return { ok: true, link };
}

/** Agrega una forma alterna de JID (LID/teléfono) al vínculo si no la tiene. */
function addAlias(link, jid) {
    if (jid && !link.jids.includes(jid)) link.jids.push(jid);
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
    loadRoster, saveRoster, findByJid, findByGamertag,
    linkJid, addAlias, unlinkGamertag, matchGamertag, levenshtein,
    ROSTER_FILE
};
