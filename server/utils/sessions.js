/**
 * Sesiones, enfrentamientos y rondas (comando !rondas, exclusivo 2v2).
 *
 * Modelo de la comunidad Retas H3:
 *   PARTIDA (1 mapa) -> RONDA (primera a 2 partidas ganadas; se apuesta $25/ronda)
 *   -> SESIÓN (la "noche": cadena de partidas sin huecos largos, cruza medianoche)
 *
 * Reglas cerradas con el dueño:
 *  - Sesión: huecos < SESSION_GAP_MINUTES (default 150) = misma sesión.
 *  - Enfrentamiento: la división de personas en dos equipos. Ignora el color
 *    (azul/rojo); si vuelven a la misma alineación más tarde, se REANUDA.
 *  - Ronda: primera a 2 victorias (en 2-0 se termina). Empates no suman.
 *  - Dinero: $RONDA_MXN por ronda COMPLETA. Rondas en curso no cobran.
 *  - Solo partidas válidas entran (las anuladas por reinicio/abandono son invisibles).
 */

const { formatCDMXDateTime } = require('./cdmxTime');
const { sanitizeCaptionText } = require('./matchSummary');

const SESSION_GAP_MINUTES = parseInt(process.env.SESSION_GAP_MINUTES || '150', 10);
const RONDA_MXN = parseInt(process.env.RONDA_MXN || '25', 10);

/**
 * Agrupa partidas (con players anidados) en sesiones por continuidad temporal.
 * @param {array} games - partidas válidas, cualquier orden
 * @returns {array<array>} sesiones ordenadas de más antigua a más reciente
 */
function clusterSessions(games, gapMinutes = SESSION_GAP_MINUTES) {
    const sorted = [...games].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const sessions = [];
    let current = [];
    let lastTs = null;

    for (const g of sorted) {
        const ts = new Date(g.timestamp).getTime();
        if (lastTs !== null && ts - lastTs > gapMinutes * 60 * 1000) {
            if (current.length) sessions.push(current);
            current = [];
        }
        current.push(g);
        lastTs = ts;
    }
    if (current.length) sessions.push(current);
    return sessions;
}

/**
 * Sesión actual (si sigue viva) o la última jugada.
 * @returns {{ games: array, live: boolean } | null}
 */
function currentOrLastSession(games, now = Date.now(), gapMinutes = SESSION_GAP_MINUTES) {
    const sessions = clusterSessions(games, gapMinutes);
    if (!sessions.length) return null;
    const last = sessions[sessions.length - 1];
    const lastTs = new Date(last[last.length - 1].timestamp).getTime();
    return { games: last, live: (now - lastTs) < gapMinutes * 60 * 1000 };
}

/** Nombres de un equipo para agrupar (orden alfabético estable), "A·B" */
const sideLabel = members => [...members].sort((a, b) => a.localeCompare(b)).join('·');

/** Nombres de un equipo para mostrar al usuario, "A + B" (más legible) */
const sideDisplay = (members, clean) => [...members].sort((a, b) => a.localeCompare(b)).map(clean).join(' + ');

/**
 * Llave y lados de la alineación de una partida (color-agnóstica).
 * @returns {{ key: string, sides: [string[], string[]] }} lados en orden estable
 */
function lineupOf(game) {
    const teams = new Map();
    for (const p of game.players || []) {
        const tid = p.team_id ?? 0;
        if (!teams.has(tid)) teams.set(tid, []);
        teams.get(tid).push(p.gamertag);
    }
    const sides = [...teams.values()];
    // Orden estable por etiqueta (independiente del color de equipo en el lobby)
    sides.sort((a, b) => sideLabel(a).localeCompare(sideLabel(b)));
    return { key: sides.map(sideLabel).join(' vs '), sides };
}

/** Puntaje de un lado (conjunto de gamertags) en una partida */
function sideScore(game, sideMembers) {
    const set = new Set(sideMembers);
    return (game.players || [])
        .filter(p => set.has(p.gamertag))
        .reduce((sum, p) => sum + (Number(p.score) || 0), 0);
}

/**
 * Agrupa la sesión en enfrentamientos (por alineación, reanudables) y corta
 * cada uno en rondas (primera a 2; empates no suman).
 * @returns {array<{ key, sides, rondas: array, current: object|null, wonA, wonB }>}
 *   ronda = { winner: 0|1, games: [{ map, scoreA, scoreB, win: boolean|null }] }
 *   current = ronda en curso { winsA, winsB, games } o null
 */
function computeEnfrentamientos(sessionGames) {
    const byLineup = new Map();

    for (const g of sessionGames) {
        const { key, sides } = lineupOf(g);
        if (!byLineup.has(key)) {
            byLineup.set(key, { key, sides, rondas: [], acc: { winsA: 0, winsB: 0, games: [] }, order: byLineup.size });
        }
        const e = byLineup.get(key);
        const scoreA = sideScore(g, e.sides[0]);
        const scoreB = sideScore(g, e.sides[1]);
        const win = scoreA > scoreB ? 0 : (scoreB > scoreA ? 1 : null); // null = empate

        e.acc.games.push({ map: g.map_name, scoreA, scoreB, win, timestamp: g.timestamp });
        if (win === 0) e.acc.winsA++;
        if (win === 1) e.acc.winsB++;

        // Primera a 2: se cierra la ronda y se arranca acumulador nuevo
        if (e.acc.winsA === 2 || e.acc.winsB === 2) {
            e.rondas.push({ winner: e.acc.winsA === 2 ? 0 : 1, games: e.acc.games });
            e.acc = { winsA: 0, winsB: 0, games: [] };
        }
    }

    return [...byLineup.values()]
        .sort((a, b) => a.order - b.order)
        .map(e => ({
            key: e.key,
            sides: e.sides,
            rondas: e.rondas,
            current: e.acc.games.length ? e.acc : null,
            wonA: e.rondas.filter(r => r.winner === 0).length,
            wonB: e.rondas.filter(r => r.winner === 1).length,
        }));
}

/** Etiqueta de fecha estilo "SÁB 5 JUL" en horario CDMX */
function sessionDateLabel(timestamp) {
    const parts = new Intl.DateTimeFormat('es-MX', {
        timeZone: 'America/Mexico_City', weekday: 'short', day: 'numeric', month: 'short'
    }).formatToParts(new Date(timestamp));
    const get = t => (parts.find(p => p.type === t) || {}).value || '';
    return `${get('weekday')} ${get('day')} ${get('month')}`.toUpperCase().replace(/\./g, '');
}

/**
 * Mensaje de WhatsApp del comando !rondas.
 */
function formatRondasMessage(session) {
    if (!session || !session.games.length) {
        return '🎮 Aún no hay retas registradas. ¡Jueguen la primera!';
    }

    const games = session.games;
    const label = sessionDateLabel(games[0].timestamp);
    const estado = session.live ? '🟢 En curso' : '🔴 Terminada';
    const enfs = computeEnfrentamientos(games);
    const clean = s => sanitizeCaptionText(s);

    const lines = [
        `🎮 *RETAS · ${label}*`,
        `${estado} · ${games.length} partida${games.length !== 1 ? 's' : ''} jugada${games.length !== 1 ? 's' : ''}`
    ];
    const cuenta = [];

    for (const e of enfs) {
        // El equipo que va ganando la sesión (más rondas) se muestra a la izquierda.
        const flip = e.wonB > e.wonA;
        const [leftMembers, rightMembers] = flip ? [e.sides[1], e.sides[0]] : [e.sides[0], e.sides[1]];
        const [wonL, wonR] = flip ? [e.wonB, e.wonA] : [e.wonA, e.wonB];
        const nameL = sideDisplay(leftMembers, clean);
        const nameR = sideDisplay(rightMembers, clean);
        // Marcador de cada partida en la orientación de display (izquierda-derecha)
        const orient = g => flip ? { map: g.map, sL: g.scoreB, sR: g.scoreA, win: g.win } : { map: g.map, sL: g.scoreA, sR: g.scoreB, win: g.win };
        const gameStr = g => { const o = orient(g); return `${clean(o.map)} ${o.sL}-${o.sR}${o.win === null ? ' (empate)' : ''}`; };

        lines.push('', '━━━━━━━━━━━━', `*${nameL}*  🆚  *${nameR}*`, '');

        // Marcador grande + dinero, en lenguaje natural
        if (wonL === wonR) {
            lines.push(`Rondas ganadas: *${wonL} - ${wonR}* (empatados)`);
        } else {
            lines.push(`Rondas ganadas: *${wonL} - ${wonR}* → van ganando *${wonL > wonR ? nameL : nameR}*`);
            const debtor = wonL > wonR ? nameR : nameL;
            const amount = Math.abs(wonL - wonR) * RONDA_MXN;
            lines.push(`💰 *${debtor}* deben *$${amount}*`);
            cuenta.push(`${debtor} → $${amount}`);
        }

        // Detalle por ronda (trazabilidad): quién la ganó, las partidas y la
        // cuenta corriente de $ al cierre de cada ronda.
        lines.push('');
        let runL = 0, runR = 0;
        e.rondas.forEach((r, i) => {
            const ganador = sideDisplay(e.sides[r.winner], clean);
            const wonByLeft = flip ? r.winner === 1 : r.winner === 0;
            if (wonByLeft) runL++; else runR++;
            lines.push(`✅ *Ronda ${i + 1}* — la ganó ${ganador}`);
            r.games.forEach(g => lines.push(`     • ${gameStr(g)}`));
            if (runL === runR) {
                lines.push(`     💰 Cuenta: a mano ($0)`);
            } else {
                const debtor = runL > runR ? nameR : nameL;
                lines.push(`     💰 Cuenta: ${debtor} deben $${Math.abs(runL - runR) * RONDA_MXN}`);
            }
        });
        if (e.current) {
            const [curL, curR] = flip ? [e.current.winsB, e.current.winsA] : [e.current.winsA, e.current.winsB];
            const rn = e.rondas.length + 1;
            let head;
            if (session.live) {
                // Sesión viva: la ronda se está jugando ahora
                let estado;
                if (curL > curR) estado = `va ganando *${nameL}* ${curL}-${curR}`;
                else if (curR > curL) estado = `va ganando *${nameR}* ${curR}-${curL}`;
                else estado = `van parejos ${curL}-${curR}`;
                head = `🕐 *Ronda ${rn}* (jugándose) — ${estado}`;
            } else {
                // Sesión terminada con una ronda a medias: quedó sin resolver, NO cuenta
                let estado;
                if (curL > curR) estado = `iban ${curL}-${curR} arriba *${nameL}*`;
                else if (curR > curL) estado = `iban ${curR}-${curL} arriba *${nameR}*`;
                else estado = `iban parejos ${curL}-${curR}`;
                head = `⏸️ *Ronda ${rn}* quedó sin terminar (${estado}) — no cuenta`;
            }
            lines.push(head);
            e.current.games.forEach(g => lines.push(`     • ${gameStr(g)}`));
        }
    }

    if (cuenta.length) {
        lines.push('', '━━━━━━━━━━━━', '💰 *Cuenta de la noche*', ...cuenta.map(c => `   ${c}`));
    }

    return lines.join('\n');
}

module.exports = {
    clusterSessions, currentOrLastSession, computeEnfrentamientos,
    lineupOf, formatRondasMessage, sessionDateLabel,
    SESSION_GAP_MINUTES, RONDA_MXN
};
