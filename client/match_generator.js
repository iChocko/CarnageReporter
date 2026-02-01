/**
 * Generador de Partidas Realistas
 * Simula datos de partidas de Halo 3 MCC
 */

const MAPS = ['Guardian', 'The Pit', 'Narrows', 'Construct', 'Heretic', 'Blackout', 'Avalanche'];
const GAME_MODES = ['Team Slayer', 'Team BRs', 'Team Snipers', 'Team Doubles', 'Rumble Pit'];
const PLAYLISTS = ['Social Slayer', 'MLG', 'Team Hardcore', 'Lone Wolves', 'Custom Games'];

const PLAYER_POOL = [
    'iChocko', 'Spartan 117', 'Elite Slayer', 'Ghost Rider', 'Pyro Master',
    'Shadow Fox', 'Cortana AI', 'Noble Six', 'The Arbiter', 'Emile A239',
    'Carter A259', 'Jorge 052', 'Kat B320', 'Jun A266', 'Master Chief',
    'Locke Jameson', 'Buck Nathan', 'Dare Veronica', 'Romeo', 'Dutch'
];

/**
 * Genera stats aleatorias pero realistas para un jugador
 */
function generatePlayerStats(isWinner, teamSize) {
    const baseKills = isWinner ?
        Math.floor(Math.random() * 15) + 10 :
        Math.floor(Math.random() * 12) + 5;

    const deaths = Math.floor(Math.random() * 15) + 8;
    const assists = Math.floor(Math.random() * 10) + 2;
    const killingSpree = Math.floor(Math.random() * 8) + 3;

    return {
        kills: baseKills,
        deaths,
        assists,
        score: baseKills,
        killingSpree,
        betrayals: Math.random() > 0.9 ? 1 : 0,
        suicides: Math.random() > 0.85 ? 1 : 0
    };
}

/**
 * Genera una partida completa con datos realistas
 * @param {number} matchNumber - Número de partida
 * @param {boolean} is4v4 - Si es 4v4, si no será FFA
 */
function generateMatch(matchNumber = 1, is4v4 = true) {
    const map = MAPS[Math.floor(Math.random() * MAPS.length)];
    const gameMode = GAME_MODES[Math.floor(Math.random() * GAME_MODES.length)];
    const playlist = PLAYLISTS[Math.floor(Math.random() * PLAYLISTS.length)];
    const isMatchmaking = Math.random() > 0.7;

    const gameUniqueId = `realistic-match-${Date.now()}-${matchNumber}`;
    const timestamp = new Date().toISOString();
    const duration = Math.floor(Math.random() * 300) + 420; // 7-12 minutos

    // Seleccionar jugadores aleatorios
    const shuffled = [...PLAYER_POOL].sort(() => 0.5 - Math.random());
    const numPlayers = is4v4 ? 8 : Math.floor(Math.random() * 4) + 4; // 4-8 para FFA
    const selectedPlayers = shuffled.slice(0, numPlayers);

    // Determinar equipo ganador
    const winningTeam = Math.random() > 0.5 ? 0 : 1;

    const gameData = {
        gameUniqueId,
        mapName: map,
        gameTypeName: gameMode,
        timestamp,
        playlistName: playlist,
        duration,
        isMatchmaking,
        gameEnum: Math.floor(Math.random() * 1000),
        isTeamsEnabled: is4v4,
        hopperName: playlist
    };

    const players = selectedPlayers.map((name, idx) => {
        const teamId = is4v4 ? (idx < numPlayers / 2 ? 0 : 1) : idx;
        const isWinner = is4v4 ? (teamId === winningTeam) : (idx === 0);
        const stats = generatePlayerStats(isWinner, is4v4);

        return {
            gamertag: name,
            teamId,
            serviceId: `${String.fromCharCode(65 + teamId)}${idx}`,
            xboxUserId: `xbox-${name.toLowerCase().replace(/\s/g, '-')}`,
            ...stats,
            standing: idx,
            clanTag: Math.random() > 0.7 ? 'H3' : null,
            mostKillsInARow: stats.killingSpree
        };
    });

    // Calcular scores de equipo
    if (is4v4) {
        const team0Score = players.filter(p => p.teamId === 0).reduce((sum, p) => sum + p.kills, 0);
        const team1Score = players.filter(p => p.teamId === 1).reduce((sum, p) => sum + p.kills, 0);

        console.log(`\n🎮 Partida ${matchNumber} generada:`);
        console.log(`   🗺️  ${map} - ${gameMode}`);
        console.log(`   🔵 Team Blue: ${team0Score} kills`);
        console.log(`   🔴 Team Red: ${team1Score} kills`);
        console.log(`   ⏱️  Duración: ${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')}`);
        console.log(`   👥 ${players.length} jugadores`);
    }

    return {
        gameData,
        players,
        filename: `${gameUniqueId}.xml`
    };
}

/**
 * Genera múltiples partidas
 */
function generateMatches(count = 2, is4v4 = true) {
    const matches = [];
    for (let i = 1; i <= count; i++) {
        matches.push(generateMatch(i, is4v4));
    }
    return matches;
}

module.exports = {
    generateMatch,
    generateMatches,
    MAPS,
    GAME_MODES,
    PLAYLISTS
};
