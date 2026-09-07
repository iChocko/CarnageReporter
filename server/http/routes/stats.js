/**
 * Endpoints públicos de stats del dashboard (Fase A2 — movidos tal cual
 * desde index.js, salvo que ahora leen las partidas vía el cache).
 */

'use strict';

const express = require('express');
const { asyncHandler } = require('../errors');
const { FORMATS } = require('../../utils/format');
const { computeRecords, computeH2H, computePlayerProfile, aggregatePlayers, computeSlayerScore } = require('../../utils/records');
const { currentOrLastSession, summarizeSession, RONDA_MXN } = require('../../utils/sessions');
const { computeSaldos, getLastCorteTs } = require('../../utils/saldos');
const { getResetTs } = require('../../utils/rondasReset');
const { getRondasGames, getSaldosGames } = require('../../domain/rondas');
const { loadRoster } = require('../../utils/roster');

// Formato pedido en el query (?format=2v2|4v4), default 2v2.
function reqFormat(req) {
    return FORMATS.includes(req.query.format) ? req.query.format : '2v2';
}

function createStatsRouter(ctx) {
    const router = express.Router();

    // Lecturas públicas cacheables 30s (el dashboard hace polling; el cache
    // de gamesCache ya tiene TTL de 5 min, esto solo evita re-servir el mismo
    // JSON en ráfagas cortas de varios visitantes a la vez).
    router.use((req, res, next) => {
        res.set('Cache-Control', 'public, max-age=30');
        next();
    });

    /**
     * Global Stats por formato
     */
    router.get('/api/stats/global', asyncHandler(async (req, res) => {
        const games = await ctx.gamesCache.getAllValidGamesWithPlayers(reqFormat(req));
        const players = aggregatePlayers(games);

        const totals = players.reduce((acc, p) => ({
            totalKills: acc.totalKills + p.total_kills,
            totalDeaths: acc.totalDeaths + p.total_deaths,
            totalPlayers: acc.totalPlayers + 1
        }), { totalKills: 0, totalDeaths: 0, totalPlayers: 0 });

        res.json({
            ...totals,
            totalGames: games.length,
            avgKD: totals.totalDeaths > 0 ? (totals.totalKills / totals.totalDeaths).toFixed(2) : totals.totalKills.toFixed(2)
        });
    }));

    /**
     * MVP & Top Performers por formato
     */
    router.get('/api/stats/mvp', asyncHandler(async (req, res) => {
        const MIN_GAMES = parseInt(ctx.config.LEADERBOARD_MIN_GAMES || '5', 10);

        const games = await ctx.gamesCache.getAllValidGamesWithPlayers(reqFormat(req));
        const data = aggregatePlayers(games);

        // Calculate KDA and efficiency for all players
        const playersWithMLG = data.map(p => {
            const kda = p.total_deaths > 0
                ? ((p.total_kills + p.total_assists) / p.total_deaths)
                : (p.total_kills + p.total_assists);
            const gamesPlayed = p.total_games || 1;
            const efficiency = (p.total_kills / gamesPlayed) - (p.total_deaths / gamesPlayed);
            return { ...p, kda, efficiency };
        });

        // Mismo mínimo de partidas que el leaderboard.
        // Nota: los sorts usan copias ([...arr]) para no mutar la lista base
        // (antes el segundo cálculo heredaba el orden del primero).
        const eligiblePlayers = playersWithMLG.filter(p => p.total_games >= MIN_GAMES);

        const mvp = eligiblePlayers.length > 0
            ? [...eligiblePlayers].sort((a, b) => b.kda - a.kda)[0] : null;

        const topEfficiency = eligiblePlayers.length > 0
            ? [...eligiblePlayers].sort((a, b) => b.efficiency - a.efficiency)[0] : null;

        // Spree King: dato puntual, cuenta para todos (sin mínimo)
        const spreeKing = playersWithMLG.length > 0
            ? [...playersWithMLG].sort((a, b) => (b.best_spree || 0) - (a.best_spree || 0))[0] : null;

        const mostConsistent = eligiblePlayers.length > 0
            ? [...eligiblePlayers].sort((a, b) =>
                (b.total_score / b.total_games) - (a.total_score / a.total_games))[0]
            : null;

        res.json({
            mvp: mvp ? { ...mvp, kda: Math.round(mvp.kda * 100) / 100 } : null,
            topEfficiency: topEfficiency ? { ...topEfficiency, efficiency: Math.round(topEfficiency.efficiency * 10) / 10 } : null,
            spreeKing: spreeKing || null,
            mostConsistent: mostConsistent || null
        });
    }));

    /**
     * Leaderboard con métricas MLG Halo 3
     */
    router.get('/api/stats/leaderboard', asyncHandler(async (req, res) => {
        const clampInt = (v, def, lo, hi) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : def;
        };
        const MIN_GAMES = clampInt(req.query.minGames ?? ctx.config.LEADERBOARD_MIN_GAMES, 5, 0, 1000);
        const limit = clampInt(req.query.limit, 20, 1, 100);

        // Agregar jugadores y récord V-D-E desde las partidas del formato pedido
        const allGames = await ctx.gamesCache.getAllValidGamesWithPlayers(reqFormat(req));
        const data = aggregatePlayers(allGames);
        const records = computeRecords(allGames);

        // Calcular métricas MLG para cada jugador
        const mlgLeaderboard = data.map(player => {
            const kda = player.total_deaths > 0
                ? ((player.total_kills + player.total_assists) / player.total_deaths)
                : (player.total_kills + player.total_assists);

            const gamesPlayed = player.total_games || 1;
            const efficiency = (player.total_kills / gamesPlayed) - (player.total_deaths / gamesPlayed);
            const bestSpree = player.best_spree || 0;

            // Slayer Score 0-100 (misma fórmula que usa el armador de equipos)
            const slayerScore = computeSlayerScore(player);

            // Tier por Slayer Score; con pocas partidas aún no compite (Placement)
            const isPlacement = (player.total_games || 0) < MIN_GAMES;
            let tier, tierColor;
            if (isPlacement) {
                tier = 'Placement';
                tierColor = '#7d8fa0'; // Gris
            } else if (slayerScore >= 75) {
                tier = 'Pro';
                tierColor = '#FFD700'; // Gold
            } else if (slayerScore >= 60) {
                tier = 'Semi-Pro';
                tierColor = '#C0C0C0'; // Silver
            } else if (slayerScore >= 45) {
                tier = 'Competitive';
                tierColor = '#CD7F32'; // Bronze
            } else {
                tier = 'Amateur';
                tierColor = '#94a3b8';
            }

            const record = records.get(player.gamertag) || { wins: 0, losses: 0, draws: 0 };

            return {
                ...player,
                kda: Math.round(kda * 100) / 100,
                efficiency: Math.round(efficiency * 10) / 10,
                avg_spree: bestSpree,
                slayer_score: Math.round(slayerScore * 10) / 10,
                tier,
                tier_color: tierColor,
                is_placement: isPlacement,
                wins: record.wins,
                losses: record.losses,
                draws: record.draws
            };
        });

        // Placement al final; el resto por Slayer Score
        mlgLeaderboard.sort((a, b) =>
            (a.is_placement === b.is_placement)
                ? b.slayer_score - a.slayer_score
                : (a.is_placement ? 1 : -1)
        );

        res.json(mlgLeaderboard.slice(0, limit));
    }));

    router.get('/api/stats/recent', asyncHandler(async (req, res) => {
        const gamesWithPlayers = await ctx.gamesCache.getRecentGamesWithPlayers(10, reqFormat(req));
        res.json(gamesWithPlayers);
    }));

    /**
     * Lista simple de jugadores del formato (para buscadores/selectores del dashboard)
     */
    router.get('/api/stats/players', asyncHandler(async (req, res) => {
        const games = await ctx.gamesCache.getAllValidGamesWithPlayers(reqFormat(req));
        const players = aggregatePlayers(games)
            .map(p => ({ gamertag: p.gamertag, total_games: p.total_games }))
            .sort((a, b) => a.gamertag.localeCompare(b.gamertag));
        res.json(players);
    }));

    /**
     * Head-to-head entre dos jugadores: como rivales y como dupla.
     * GET /api/stats/h2h?p1=<gamertag>&p2=<gamertag>
     */
    router.get('/api/stats/h2h', asyncHandler(async (req, res) => {
        const { p1, p2 } = req.query;
        if (!p1 || !p2) {
            return res.status(400).json({ error: 'Faltan p1 y/o p2' });
        }
        if (String(p1).toLowerCase() === String(p2).toLowerCase()) {
            return res.status(400).json({ error: 'Elige dos jugadores distintos' });
        }
        const games = await ctx.gamesCache.getAllValidGamesWithPlayers(reqFormat(req));
        res.json(computeH2H(games, p1, p2));
    }));

    /**
     * Perfil de un jugador: totales, récord V-D-E e historial de partidas.
     * GET /api/stats/player/:gamertag
     */
    router.get('/api/stats/player/:gamertag', asyncHandler(async (req, res) => {
        const games = await ctx.gamesCache.getAllValidGamesWithPlayers(reqFormat(req));
        const profile = computePlayerProfile(games, req.params.gamertag);
        if (!profile) {
            return res.status(404).json({ error: `No hay partidas de '${req.params.gamertag}'` });
        }
        res.json(profile);
    }));

    /**
     * Marcador de la reta en curso (o la última jugada), para la vista web
     * de !rondas. Misma fuente de verdad que el mensaje de WhatsApp
     * (utils/sessions.js summarizeSession).
     * GET /api/stats/rondas
     */
    router.get('/api/stats/rondas', asyncHandler(async (req, res) => {
        const games = await getRondasGames(ctx);
        const session = summarizeSession(currentOrLastSession(games));
        res.json({ session, rondaMxn: RONDA_MXN });
    }));

    /**
     * Saldos netos pendientes desde el último corte semanal (o el último
     * !rondas reset si nunca ha habido corte), para la vista web.
     * GET /api/stats/saldos
     */
    router.get('/api/stats/saldos', asyncHandler(async (req, res) => {
        const sinceTs = getLastCorteTs(ctx.outputDir) ?? getResetTs(ctx.outputDir);
        const games = await getSaldosGames(ctx);
        res.json({ sinceTs, gamesCount: games.length, saldos: computeSaldos(games) });
    }));

    /**
     * Roster público: solo gamertag y si ya jugó (known). NUNCA expone JIDs
     * de WhatsApp (números de teléfono) — ver server/utils/roster.js.
     * GET /api/stats/roster
     */
    router.get('/api/stats/roster', asyncHandler(async (req, res) => {
        const games = await ctx.gamesCache.getAllValidGamesWithPlayers(reqFormat(req));
        const totalsByTag = new Map(aggregatePlayers(games).map(p => [p.gamertag.toLowerCase(), p.total_games]));
        const roster = loadRoster(ctx.outputDir).links.map(l => ({
            gamertag: l.gamertag,
            known: !!l.known,
            totalGames: totalsByTag.get(String(l.gamertag).toLowerCase()) || 0,
        }));
        res.json(roster);
    }));

    return router;
}

module.exports = { createStatsRouter, reqFormat };
