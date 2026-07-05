/**
 * Récords y comparativas calculados a partir de partidas válidas con jugadores.
 * Todo en JS (sin vistas SQL adicionales): a escala de comunidad (cientos de
 * partidas) una pasada en memoria es más simple de mantener que DDL en Supabase.
 *
 * Formato esperado de cada partida: { game_unique_id, map_name, timestamp,
 * players: [{ gamertag, team_id, score, kills, deaths, assists, ... }] }
 */

const norm = s => String(s || '').toLowerCase();

/**
 * Resultado por jugador de UNA partida por equipos.
 * @returns {Map<gamertag, 'W'|'L'|'D'>}
 */
function teamOutcomes(game) {
    const teams = new Map();
    for (const p of game.players || []) {
        const tid = p.team_id ?? 0;
        if (!teams.has(tid)) teams.set(tid, { score: 0, members: [] });
        const t = teams.get(tid);
        t.score += p.score;
        t.members.push(p.gamertag);
    }

    const out = new Map();
    const list = [...teams.values()].sort((a, b) => b.score - a.score);
    if (list.length < 2) return out;

    const isDraw = list[0].score === list[1].score;
    list.forEach((t, i) => {
        const result = isDraw ? 'D' : (i === 0 ? 'W' : 'L');
        t.members.forEach(m => out.set(m, result));
    });
    return out;
}

/**
 * Récord V-D-E acumulado por gamertag.
 * @returns {Map<gamertag, {wins, losses, draws}>}
 */
function computeRecords(games) {
    const records = new Map();
    for (const g of games) {
        for (const [tag, result] of teamOutcomes(g)) {
            if (!records.has(tag)) records.set(tag, { wins: 0, losses: 0, draws: 0 });
            const r = records.get(tag);
            if (result === 'W') r.wins++;
            else if (result === 'L') r.losses++;
            else r.draws++;
        }
    }
    return records;
}

/**
 * Head-to-head entre dos jugadores: como rivales y como dupla.
 */
function computeH2H(games, p1, p2) {
    const rivals = { total: 0, p1Wins: 0, p2Wins: 0, draws: 0 };
    const duo = { total: 0, wins: 0, losses: 0, draws: 0 };
    const shared = [];
    let p1Real = null, p2Real = null;

    for (const g of games) {
        const players = g.players || [];
        const a = players.find(p => norm(p.gamertag) === norm(p1));
        const b = players.find(p => norm(p.gamertag) === norm(p2));
        if (!a || !b) continue;

        p1Real = a.gamertag;
        p2Real = b.gamertag;
        const outcomes = teamOutcomes(g);
        const ra = outcomes.get(a.gamertag) || null;
        const rb = outcomes.get(b.gamertag) || null;
        const sameTeam = (a.team_id ?? 0) === (b.team_id ?? 0);

        if (sameTeam) {
            duo.total++;
            if (ra === 'W') duo.wins++;
            else if (ra === 'L') duo.losses++;
            else duo.draws++;
        } else {
            rivals.total++;
            if (ra === 'W') rivals.p1Wins++;
            else if (rb === 'W') rivals.p2Wins++;
            else rivals.draws++;
        }

        shared.push({
            game_unique_id: g.game_unique_id,
            map_name: g.map_name,
            timestamp: g.timestamp,
            same_team: sameTeam,
            p1: { gamertag: a.gamertag, kills: a.kills, deaths: a.deaths, assists: a.assists, score: a.score, result: ra },
            p2: { gamertag: b.gamertag, kills: b.kills, deaths: b.deaths, assists: b.assists, score: b.score, result: rb }
        });
    }

    return { p1: p1Real || p1, p2: p2Real || p2, rivals, duo, shared: shared.slice(0, 15) };
}

/**
 * Perfil de un jugador: totales, récord e historial.
 */
function computePlayerProfile(games, gamertag) {
    const totals = { games: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0, assists: 0, score: 0, bestSpree: 0 };
    const history = [];
    let realTag = null;

    for (const g of games) {
        const me = (g.players || []).find(p => norm(p.gamertag) === norm(gamertag));
        if (!me) continue;

        realTag = me.gamertag;
        const result = teamOutcomes(g).get(me.gamertag) || null;
        totals.games++;
        if (result === 'W') totals.wins++;
        else if (result === 'L') totals.losses++;
        else if (result === 'D') totals.draws++;
        totals.kills += me.kills;
        totals.deaths += me.deaths;
        totals.assists += me.assists;
        totals.score += me.score;
        totals.bestSpree = Math.max(totals.bestSpree, me.most_kills_in_a_row || 0);

        history.push({
            game_unique_id: g.game_unique_id,
            map_name: g.map_name,
            timestamp: g.timestamp,
            result,
            kills: me.kills,
            deaths: me.deaths,
            assists: me.assists,
            score: me.score,
            kd: me.deaths > 0 ? Math.round((me.kills / me.deaths) * 100) / 100 : me.kills
        });
    }

    if (!realTag) return null;

    const kd = totals.deaths > 0 ? totals.kills / totals.deaths : totals.kills;
    const kda = totals.deaths > 0 ? (totals.kills + totals.assists) / totals.deaths : (totals.kills + totals.assists);

    return {
        gamertag: realTag,
        ...totals,
        kd: Math.round(kd * 100) / 100,
        kda: Math.round(kda * 100) / 100,
        history // ya viene reciente -> antiguo (los juegos llegan ordenados desc)
    };
}

module.exports = { teamOutcomes, computeRecords, computeH2H, computePlayerProfile };
