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
 *   ronda = { winner: 0|1, games: [{ map, scoreA, scoreB, win: boolean|null, gameId, kind }] }
 *   current = ronda en curso { winsA, winsB, games } o null
 *   kind = 'wo' (W.O. de !perdida) | 'ajuste' (!marcador) | 'game' (partida real)
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
        const kind = g.is_forfeit ? 'wo' : (g.is_adjustment ? 'ajuste' : 'game');

        e.acc.games.push({ map: g.map_name, scoreA, scoreB, win, timestamp: g.timestamp, gameId: g.game_unique_id, kind });
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
 * Resumen estructurado (JSON-friendly) de una sesión: la misma información
 * que renderiza !rondas por WhatsApp, en forma de datos en vez de texto, para
 * que el dashboard web y el mensaje de WhatsApp compartan una sola fuente de
 * verdad (formatRondasMessage se arma a partir de esto — ver más abajo).
 *
 * Gamertags y nombres de mapa YA vienen saneados (sanitizeCaptionText) y los
 * lados de cada enfrentamiento ya están en orientación de DISPLAY: el lado
 * que va ganando la sesión (más rondas) es siempre sides[0] (izquierda),
 * igual que hace !rondas al mostrar el equipo que va arriba a la izquierda.
 *
 * @param {{games: array, live: boolean}|null} session
 * @param {{rondaMxn?: number}} [opts]
 * @returns {object|null} null si no hay partidas
 */
function summarizeSession(session, { rondaMxn = RONDA_MXN } = {}) {
    if (!session || !session.games.length) return null;

    const games = session.games;
    const clean = s => sanitizeCaptionText(s);
    const sortClean = members => [...members].sort((a, b) => a.localeCompare(b)).map(clean);

    const cuenta = [];
    const enfrentamientos = computeEnfrentamientos(games).map(e => {
        // El equipo que va ganando la sesión (más rondas) se muestra a la izquierda.
        const flip = e.wonB > e.wonA;
        const sides = flip ? [sortClean(e.sides[1]), sortClean(e.sides[0])] : [sortClean(e.sides[0]), sortClean(e.sides[1])];
        const rondasWon = flip ? [e.wonB, e.wonA] : [e.wonA, e.wonB];

        // Partida en orientación de display (izquierda-derecha)
        const orientGame = g => ({
            gameId: g.gameId,
            map: clean(g.map),
            scores: flip ? [g.scoreB, g.scoreA] : [g.scoreA, g.scoreB],
            winnerSide: g.win === null ? null : (flip ? (g.win === 1 ? 0 : 1) : g.win),
            timestamp: g.timestamp,
            kind: g.kind,
        });

        const rondas = e.rondas.map(r => ({
            winnerSide: flip ? (r.winner === 1 ? 0 : 1) : r.winner,
            games: r.games.map(orientGame),
        }));

        const current = e.current ? {
            wins: flip ? [e.current.winsB, e.current.winsA] : [e.current.winsA, e.current.winsB],
            games: e.current.games.map(orientGame),
        } : null;

        if (rondasWon[0] !== rondasWon[1]) {
            const debtorSide = rondasWon[0] > rondasWon[1] ? 1 : 0;
            cuenta.push({
                winners: sides[1 - debtorSide],
                losers: sides[debtorSide],
                rounds: Math.abs(rondasWon[0] - rondasWon[1]),
                amountMxn: Math.abs(rondasWon[0] - rondasWon[1]) * rondaMxn,
            });
        }

        return { sides, rondasWon, rondas, current };
    });

    return {
        live: session.live,
        dateLabel: sessionDateLabel(games[0].timestamp),
        startedAt: games[0].timestamp,
        lastGameAt: games[games.length - 1].timestamp,
        gamesCount: games.length,
        enfrentamientos,
        cuenta,
    };
}

/**
 * Mensaje de WhatsApp del comando !rondas, armado a partir de
 * summarizeSession (única fuente de verdad compartida con la API web).
 */
function formatRondasMessage(session) {
    const summary = summarizeSession(session);
    if (!summary) {
        return 'Sin retas registradas todavía.';
    }

    const estado = summary.live ? '🟢 En curso' : '🔴 Terminada';
    const lines = [
        `*RETAS · ${summary.dateLabel}*`,
        `${estado} · ${summary.gamesCount} partida${summary.gamesCount !== 1 ? 's' : ''}`
    ];

    for (const e of summary.enfrentamientos) {
        const [leftMembers, rightMembers] = e.sides;
        const [wonL, wonR] = e.rondasWon;
        const nameL = leftMembers.join(' + ');
        const nameR = rightMembers.join(' + ');
        const gameStr = g => `${g.map} ${g.scores[0]}-${g.scores[1]}${g.winnerSide === null ? ' (empate)' : ''}`;

        lines.push('', '━━━━━━━━━━━━', `*${nameL}*  🆚  *${nameR}*`, '');

        // Marcador grande + dinero
        if (wonL === wonR) {
            lines.push(`Serie: *${wonL}-${wonR}* — empatada`);
        } else {
            lines.push(`Serie: *${wonL}-${wonR}* — arriba *${wonL > wonR ? nameL : nameR}*`);
            const debtor = wonL > wonR ? nameR : nameL;
            const amount = Math.abs(wonL - wonR) * RONDA_MXN;
            lines.push(`💰 *${debtor}* deben *$${amount}*`);
        }

        // Detalle por ronda (trazabilidad): quién la ganó, las partidas y la
        // cuenta corriente de $ al cierre de cada ronda.
        lines.push('');
        let runL = 0, runR = 0;
        e.rondas.forEach((r, i) => {
            const ganador = r.winnerSide === 0 ? nameL : nameR;
            if (r.winnerSide === 0) runL++; else runR++;
            lines.push(`*Ronda ${i + 1}* — ${ganador}`);
            r.games.forEach(g => lines.push(`     • ${gameStr(g)}`));
            if (runL === runR) {
                lines.push(`     💰 Cuenta: a mano ($0)`);
            } else {
                const debtor = runL > runR ? nameR : nameL;
                lines.push(`     💰 Cuenta: ${debtor} deben $${Math.abs(runL - runR) * RONDA_MXN}`);
            }
        });
        if (e.current) {
            const [curL, curR] = e.current.wins;
            const rn = e.rondas.length + 1;
            let head;
            if (summary.live) {
                // Sesión viva: la ronda se está jugando ahora. Primera a 2:
                // cualquier líder está en match point.
                let estadoRonda;
                if (curL > curR) estadoRonda = `*${nameL}* arriba ${curL}-${curR} — match point`;
                else if (curR > curL) estadoRonda = `*${nameR}* arriba ${curR}-${curL} — match point`;
                else if (curL === 0) estadoRonda = `0-0, nada suma todavía`;
                else estadoRonda = `${curL}-${curR} — la que sigue define`;
                head = `*Ronda ${rn}* — en juego · ${estadoRonda}`;
            } else {
                // Sesión terminada con una ronda a medias: quedó sin resolver, NO cuenta
                let estadoRonda;
                if (curL > curR) estadoRonda = `iban ${curL}-${curR}, arriba *${nameL}*`;
                else if (curR > curL) estadoRonda = `iban ${curR}-${curL}, arriba *${nameR}*`;
                else estadoRonda = `iban ${curL}-${curR}`;
                head = `*Ronda ${rn}* — quedó abierta (${estadoRonda}) · no cuenta`;
            }
            lines.push(head);
            e.current.games.forEach(g => lines.push(`     • ${gameStr(g)}`));
        }
    }

    if (summary.cuenta.length) {
        lines.push('', '━━━━━━━━━━━━', '💰 *Cuenta de la noche*',
            ...summary.cuenta.map(c => `   ${c.losers.join(' + ')} → $${c.amountMxn}`));
    }

    return lines.join('\n');
}

/**
 * Mensaje corto que se publica AUTOMÁTICAMENTE al terminar cada partida 2v2:
 * cómo va la ronda en curso, o el cierre de ronda cuando alguien llega a 2.
 * A diferencia de !rondas (el resumen completo), esto es una sola actualización
 * puntual del enfrentamiento al que pertenece la última partida.
 *
 * @param {{games: array, live: boolean}|null} session - sesión que YA incluye la partida recién guardada
 * @returns {string|null} mensaje de WhatsApp o null si no hay nada que anunciar
 */
function formatLiveRoundUpdate(session) {
    if (!session || !session.games.length) return null;

    const games = session.games;
    const lastGame = games[games.length - 1];
    const e = computeEnfrentamientos(games).find(x => x.key === lineupOf(lastGame).key);
    if (!e) return null;

    const clean = s => sanitizeCaptionText(s);
    const nameA = sideDisplay(e.sides[0], clean);
    const nameB = sideDisplay(e.sides[1], clean);

    // ¿La última partida CERRÓ una ronda? Si el acumulador quedó vacío, la
    // partida recién jugada es la última de la última ronda cerrada.
    const lastRonda = e.rondas[e.rondas.length - 1];
    const closedNow = !e.current && lastRonda &&
        lastRonda.games[lastRonda.games.length - 1].timestamp === lastGame.timestamp;

    const lines = [];

    if (closedNow) {
        const winnerName = lastRonda.winner === 0 ? nameA : nameB;
        lines.push(`*Ronda ${e.rondas.length}* para *${winnerName}*.`);
        if (e.wonA === e.wonB) {
            lines.push(`Serie: *${nameA}* ${e.wonA}-${e.wonB} *${nameB}* — empatada`);
            lines.push(`💰 Cuenta: a mano ($0)`);
        } else {
            const flip = e.wonB > e.wonA;
            const [leadName, trailName] = flip ? [nameB, nameA] : [nameA, nameB];
            const [w, l] = flip ? [e.wonB, e.wonA] : [e.wonA, e.wonB];
            lines.push(`Serie: *${leadName}* ${w}-${l} *${trailName}*`);
            lines.push(`💰 *${trailName}* deben $${(w - l) * RONDA_MXN}`);
        }
        return lines.join('\n');
    }

    if (!e.current) return null; // no debería pasar, pero no anunciamos nada raro

    // Ronda en curso. Primera a 2: cualquier líder está en match point.
    const rn = e.rondas.length + 1;
    const { winsA, winsB } = e.current;
    const lastWasTie = e.current.games[e.current.games.length - 1].win === null;

    let estado;
    if (winsA === winsB) {
        estado = winsA === 0
            ? `0-0 — solo empates, nada suma`
            : `*${winsA}-${winsB}* — la que sigue define la ronda`;
    } else {
        const flip = winsB > winsA;
        const leadName = flip ? nameB : nameA;
        const [w, l] = flip ? [winsB, winsA] : [winsA, winsB];
        estado = `*${leadName}* arriba *${w}-${l}* — match point`;
    }

    if (lastWasTie) lines.push(`Empate — esa no suma.`);
    lines.push(`*Ronda ${rn}* (${nameA} 🆚 ${nameB}): ${estado}`);
    return lines.join('\n');
}

module.exports = {
    clusterSessions, currentOrLastSession, computeEnfrentamientos,
    lineupOf, summarizeSession, formatRondasMessage, formatLiveRoundUpdate, sessionDateLabel,
    SESSION_GAP_MINUTES, RONDA_MXN
};
