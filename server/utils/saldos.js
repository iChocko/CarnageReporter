/**
 * Corte semanal de saldos (cron de lunes 09:00 CDMX).
 *
 * Regla de la comunidad: todos los lunes se saldan las cuentas de la semana.
 * El bot manda los saldos pendientes al grupo (etiquetando a los jugadores)
 * y reinicia el marcador para arrancar la semana nueva.
 *
 * Óptica elegida: saldos POR EQUIPO (alineación), no por persona. Quién
 * apuesta contra quién dentro de un enfrentamiento es un acuerdo privado
 * entre jugadores que el bot no conoce; lo que el bot sí sabe con certeza
 * es cuántas rondas netas ganó cada alineación. Se reporta eso y ellos se
 * reparten como hayan acordado.
 *
 * El neteo cruza TODAS las sesiones pendientes desde el último corte: si la
 * misma alineación jugó martes y viernes, sus rondas se suman en una sola
 * línea. Alineaciones distintas (aunque repitan personas) van por separado
 * — el bot no puede netear entre pareos que no conoce. Un "!rondas reset"
 * manual a media semana solo limpia el marcador visible: las deudas de la
 * semana persisten y el corte del lunes las cobra igual (ventana corte a
 * corte, no reset a corte). Las rondas a medias no cuentan (regla de
 * siempre).
 */

const fs = require('fs');
const path = require('path');

const { clusterSessions, computeEnfrentamientos, RONDA_MXN } = require('./sessions');
const { sanitizeCaptionText } = require('./matchSummary');
const { lineupKeyOf } = require('./forfeits');

/**
 * Deudas netas por alineación sobre las partidas pendientes.
 * @param {array} games - partidas (con players) desde el último reset
 * @returns {Array<{winners: string[], losers: string[], rounds: number, amount: number}>}
 *   ordenadas de mayor a menor deuda; alineaciones a mano no aparecen.
 */
function computeSaldos(games) {
    const byLineup = new Map();
    for (const session of clusterSessions(games)) {
        for (const e of computeEnfrentamientos(session)) {
            // lineupOf ordena los lados de forma estable, así que sides[0]
            // es el mismo lado físico cada vez que aparece esta alineación.
            const key = lineupKeyOf(e.sides);
            if (!byLineup.has(key)) byLineup.set(key, { sides: e.sides, net: 0 });
            byLineup.get(key).net += e.wonA - e.wonB;
        }
    }

    const saldos = [];
    for (const { sides, net } of byLineup.values()) {
        if (net === 0) continue;
        const winnerIdx = net > 0 ? 0 : 1;
        saldos.push({
            winners: sides[winnerIdx],
            losers: sides[1 - winnerIdx],
            rounds: Math.abs(net),
            amount: Math.abs(net) * RONDA_MXN,
        });
    }
    return saldos.sort((a, b) => b.amount - a.amount);
}

/**
 * Mensaje del corte semanal, con menciones reales cuando hay JID en el roster.
 * @param {array} saldos - de computeSaldos
 * @param {number} gamesCount - partidas pendientes (0 = no hay corte que anunciar)
 * @param {Map<string,string>} [mentionJidByLower] - gamertagLower -> JID
 * @returns {{text: string, mentions: string[]}|null} null si no hubo retas
 */
function formatSaldosMessage(saldos, gamesCount, mentionJidByLower) {
    if (!gamesCount) return null;

    // La decisión mención-vs-texto se toma por el lookup del roster, NUNCA por
    // el contenido del nombre: un gamertag no registrado que empiece con "@"
    // debe pasar por sanitize como cualquier otro (viene del payload del cliente).
    const show = name => {
        const jid = mentionJidByLower?.get(String(name).toLowerCase());
        return jid ? `@${String(jid).split('@')[0]}` : sanitizeCaptionText(name);
    };
    const sideStr = side => [...side].sort((a, b) => a.localeCompare(b)).map(show).join(' + ');

    const lines = ['*CORTE SEMANAL*'];
    if (!saldos.length) {
        lines.push('Semana a mano: nadie debe nada.');
    } else {
        for (const s of saldos) {
            lines.push(`💰 ${sideStr(s.losers)} deben *$${s.amount}* a ${sideStr(s.winners)}`);
        }
        lines.push('Hoy se saldan las cuentas.');
    }
    lines.push('Marcador en ceros: arranca semana nueva.');

    const mentions = [];
    if (mentionJidByLower) {
        for (const s of saldos) {
            for (const name of [...s.winners, ...s.losers]) {
                const jid = mentionJidByLower.get(String(name).toLowerCase());
                if (jid && !mentions.includes(jid)) mentions.push(jid);
            }
        }
    }
    return { text: lines.join('\n'), mentions };
}

// ---------- Marcador del corte (para no repetirlo si el cron reintenta) ----------

const CORTE_FILE = 'saldos_corte.json';

/** Timestamp (ms epoch) del último corte hecho, o null. */
function getLastCorteTs(dir) {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, CORTE_FILE), 'utf-8'));
        return Number.isFinite(data.lastCorteTs) ? data.lastCorteTs : null;
    } catch (e) {
        return null;
    }
}

/** Registra que el corte de hoy ya se hizo. */
function setLastCorteTs(dir, ts = Date.now()) {
    fs.writeFileSync(path.join(dir, CORTE_FILE), JSON.stringify({ lastCorteTs: ts, corteAt: new Date(ts).toISOString() }));
    return ts;
}

/** ¿Dos instantes caen en el mismo día calendario de CDMX? */
function isSameCdmxDay(tsA, tsB) {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' });
    return fmt.format(new Date(tsA)) === fmt.format(new Date(tsB));
}

module.exports = { computeSaldos, formatSaldosMessage, getLastCorteTs, setLastCorteTs, isSameCdmxDay };
