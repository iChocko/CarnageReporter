/**
 * Construye los datos del resultado de una partida (equipo ganador + jugadores,
 * mapa, fecha/hora CDMX, ID corto) para usarlos en los captions de Discord/WhatsApp.
 * El formato de negritas es distinto por plataforma, así que este módulo solo
 * arma las piezas crudas; cada servicio las envuelve con su propia sintaxis.
 */

const { formatCDMXDateTime } = require('./cdmxTime');

/**
 * Neutraliza contenido controlado por el usuario (gamertags, mapas) antes de
 * meterlo en un caption de Discord/WhatsApp: quita saltos de línea y los
 * caracteres de formato de Markdown/WhatsApp para que un payload malicioso no
 * pueda inyectar negritas, menciones ni líneas falsas. Los gamertags reales de
 * Xbox no usan estos caracteres, así que no se ven afectados.
 */
function sanitizeCaptionText(str) {
    return String(str == null ? '' : str)
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[*_~`<>|@#\[\]()]/g, '')
        .trim();
}

const TEAM_NAMES = {
    0: 'BLUE TEAM',
    1: 'RED TEAM',
    2: 'GREEN TEAM',
    3: 'ORANGE TEAM',
    4: 'PURPLE TEAM',
    5: 'GOLD TEAM',
    6: 'BROWN TEAM',
    7: 'PINK TEAM',
};

function teamName(teamId) {
    return TEAM_NAMES[teamId] || `TEAM ${teamId}`;
}

/**
 * @returns {{ winnerText: string, winners: string[] }}
 * winnerText: "BLUE TEAM" | "EMPATE" | "<GAMERTAG>" (FFA) | "GAME OVER" (sin datos)
 */
function determineWinner(gameData, players) {
    const isTeams = gameData.isTeamsEnabled !== false;

    if (!isTeams) {
        const sorted = [...players].sort((a, b) => (a.standing - b.standing) || (b.score - a.score));
        const winner = sorted[0];
        // FFA: el ganador ES el texto; sin lista de winners para no duplicar el nombre
        return {
            winnerText: winner ? winner.gamertag.toUpperCase() : 'GAME OVER',
            winners: []
        };
    }

    const teamsMap = new Map();
    for (const p of players) {
        const tid = p.teamId ?? 0;
        if (!teamsMap.has(tid)) teamsMap.set(tid, []);
        teamsMap.get(tid).push(p);
    }

    const teams = [...teamsMap.entries()]
        .map(([tid, members]) => ({
            tid,
            members,
            totalScore: members.reduce((sum, p) => sum + p.score, 0)
        }))
        .sort((a, b) => b.totalScore - a.totalScore);

    if (teams.length >= 2 && teams[0].totalScore === teams[1].totalScore) {
        return { winnerText: 'EMPATE', winners: [] };
    }

    const winningTeam = teams[0];
    return {
        winnerText: winningTeam ? teamName(winningTeam.tid) : 'GAME OVER',
        winners: winningTeam ? winningTeam.members.map(p => p.gamertag) : []
    };
}

/**
 * Piezas ya armadas para construir un caption (sin sintaxis de negritas propia
 * de cada plataforma, para que Discord/WhatsApp la apliquen a su manera).
 */
function buildCaptionParts(gameData, players) {
    const { winnerText, winners } = determineWinner(gameData, players);
    // Sanitizar gamertags/mapa (contenido del payload) antes de armar el caption
    const safeWinners = winners.map(sanitizeCaptionText).filter(Boolean);
    const winnerLine = safeWinners.length > 0
        ? `${sanitizeCaptionText(winnerText)}: ${safeWinners.join(', ')}`
        : sanitizeCaptionText(winnerText);
    const { dateStr, timeStr } = formatCDMXDateTime(gameData.timestamp);

    return {
        winnerLine,
        mapName: sanitizeCaptionText(gameData.mapName),
        dateStr,
        timeStr,
        shortId: String(gameData.gameUniqueId || '').slice(0, 8),
        fullId: gameData.gameUniqueId
    };
}

/**
 * Formatea una lista de partidas recientes para WhatsApp (comando !partidas).
 * Por partida: integrantes de cada equipo, puntuación, mapa y fecha/hora CDMX.
 * Negritas de WhatsApp (*texto*) en los integrantes ganadores y en la fecha/hora.
 * @param {array} games - Partidas de recent_games con .players anidados (team_id, gamertag, score)
 */
function formatRecentGamesWhatsApp(games) {
    if (!games || games.length === 0) {
        return '🎮 Aún no hay partidas registradas. ¡Jueguen la primera custom!';
    }

    const lines = [`🎮 *ÚLTIMAS ${games.length} PARTIDAS*`];

    games.forEach((g, idx) => {
        const { dateStr, timeStr } = formatCDMXDateTime(g.timestamp);
        const when = `*${dateStr} ${timeStr} hrs*`;

        const tag = p => sanitizeCaptionText(p.gamertag);

        let body;
        if (g.is_teams_enabled === false) {
            // FFA: ganador en negritas, resto por puntuación
            const sorted = [...(g.players || [])].sort((a, b) => b.score - a.score);
            const [winner, ...rest] = sorted;
            body = winner
                ? `FFA: *${tag(winner)}* (${winner.score})${rest.length ? ', ' + rest.map(p => `${tag(p)} (${p.score})`).join(', ') : ''}`
                : 'Sin datos de jugadores';
        } else {
            // Equipos: agrupar por team_id y ordenar por puntuación descendente,
            // de modo que el equipo GANADOR siempre quede a la izquierda.
            const teamsMap = new Map();
            for (const p of (g.players || [])) {
                const tid = p.team_id ?? 0;
                if (!teamsMap.has(tid)) teamsMap.set(tid, []);
                teamsMap.get(tid).push(p);
            }
            const teams = [...teamsMap.values()]
                .map(members => ({
                    members: [...members].sort((a, b) => b.score - a.score),
                    score: members.reduce((s, p) => s + p.score, 0)
                }))
                .sort((a, b) => b.score - a.score);

            // Cada jugador con su score individual entre paréntesis
            const roster = t => t.members.map(p => `${tag(p)} (${p.score})`).join(', ');

            if (teams.length === 0) {
                body = 'Sin datos de jugadores';
            } else if (teams.length === 2) {
                const isDraw = teams[0].score === teams[1].score;
                const left = isDraw ? roster(teams[0]) : `*${roster(teams[0])}*`;
                body = `${left} ${teams[0].score} vs ${teams[1].score} ${roster(teams[1])}${isDraw ? ' — EMPATE 🤝' : ''}`;
            } else {
                // Layout genérico para >2 equipos (histórico; el bot ya solo registra 2v2)
                const isDraw = teams.length >= 2 && teams[0].score === teams[1].score;
                body = teams.map((t, i) => {
                    const isWinner = !isDraw && i === 0;
                    return `${isWinner ? `*${roster(t)}*` : roster(t)} [${t.score}]`;
                }).join(' vs ') + (isDraw ? ' — EMPATE 🤝' : '');
            }
        }

        lines.push(`\n${idx + 1}. ${sanitizeCaptionText(g.map_name)} — ${when}\n${body}`);
    });

    return lines.join('\n');
}

module.exports = { determineWinner, teamName, buildCaptionParts, formatRecentGamesWhatsApp, sanitizeCaptionText };
