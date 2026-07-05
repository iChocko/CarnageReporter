/**
 * Construye los datos del resultado de una partida (equipo ganador + jugadores,
 * mapa, fecha/hora CDMX, ID corto) para usarlos en los captions de Discord/WhatsApp.
 * El formato de negritas es distinto por plataforma, así que este módulo solo
 * arma las piezas crudas; cada servicio las envuelve con su propia sintaxis.
 */

const { formatCDMXDateTime } = require('./cdmxTime');

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
 * @returns {{ winnerText: string, winners: string[] }} winnerText: "BLUE TEAM WINS" | "DRAW" | "<gamertag> WINS"
 */
function determineWinner(gameData, players) {
    const isTeams = gameData.isTeamsEnabled !== false;

    if (!isTeams) {
        const sorted = [...players].sort((a, b) => (a.standing - b.standing) || (b.score - a.score));
        const winner = sorted[0];
        return {
            winnerText: winner ? `${winner.gamertag.toUpperCase()} WINS` : 'GAME OVER',
            winners: winner ? [winner.gamertag] : []
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
        return { winnerText: 'DRAW', winners: [] };
    }

    const winningTeam = teams[0];
    return {
        winnerText: winningTeam ? `${teamName(winningTeam.tid)} WINS` : 'GAME OVER',
        winners: winningTeam ? winningTeam.members.map(p => p.gamertag) : []
    };
}

/**
 * Piezas ya armadas para construir un caption (sin sintaxis de negritas propia
 * de cada plataforma, para que Discord/WhatsApp la apliquen a su manera).
 */
function buildCaptionParts(gameData, players) {
    const { winnerText, winners } = determineWinner(gameData, players);
    const winnerLine = winners.length > 0 ? `${winnerText}: ${winners.join(', ')}` : winnerText;
    const { dateStr, timeStr } = formatCDMXDateTime(gameData.timestamp);

    return {
        winnerLine,
        mapName: gameData.mapName,
        dateStr,
        timeStr,
        shortId: String(gameData.gameUniqueId || '').slice(0, 8),
        fullId: gameData.gameUniqueId
    };
}

module.exports = { determineWinner, teamName, buildCaptionParts };
