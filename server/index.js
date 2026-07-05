/**
 * CarnageReporter Server
 * Servidor centralizado para procesar reportes de Halo 3 MCC
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const Stripe = require('stripe');

// Servicios
const DiscordService = require('./services/discord');
const SupabaseService = require('./services/supabase');
const RendererService = require('./services/renderer');
const { evaluateMatch } = require('./services/validator');

// Initialize Stripe
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// Servir archivos estáticos del dashboard (Frontend)
const DASHBOARD_DIST = path.join(__dirname, '../dashboard/dist');
if (fs.existsSync(DASHBOARD_DIST)) {
    app.use(express.static(DASHBOARD_DIST));
    console.log(`🌐 Dashboard frontend listo en: ${DASHBOARD_DIST}`);
}

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
    console.error('❌ Falta la variable de entorno API_KEY. Configúrala en el .env antes de iniciar.');
    process.exit(1);
}

// Directorio de output para PNGs temporales
const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Inicializar servicios
const discord = new DiscordService();
const supabase = new SupabaseService();
const renderer = new RendererService();

// Middleware de autenticación simple
function authMiddleware(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) {
        return res.status(401).json({ error: 'API key inválida' });
    }
    next();
}

// ============== ENDPOINTS ==============

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

/**
 * Estado del servidor
 */
app.get('/api/status', (req, res) => {
    res.json({
        stats: {
            processed: supabase.getProcessedCount()
        }
    });
});

/**
 * Recibir reporte de partida
 * POST /api/report
 * Body: { gameData, players, filename }
 */
app.post('/api/report', authMiddleware, async (req, res) => {
    const { gameData, players, filename } = req.body;
    const schemaVersion = parseInt(req.body.schemaVersion || 1, 10);
    const clientVersion = req.body.clientVersion || null;

    if (!gameData || !players) {
        return res.status(400).json({ error: 'Faltan gameData o players' });
    }

    const gameId = gameData.gameUniqueId;
    console.log(`\n📥 Recibido reporte: ${gameId} (${gameData.mapName}) [v${schemaVersion}${clientVersion ? `, cliente ${clientVersion}` : ''}, ${players.length} jugadores]`);

    try {
        // 1. Verificar duplicados en Supabase
        const exists = await supabase.gameExists(gameId);
        if (exists) {
            console.log(`⏭️  Juego ${gameId} ya procesado, saltando`);
            return res.json({
                status: 'duplicate',
                gameId,
                message: 'Este juego ya fue procesado anteriormente'
            });
        }

        // 2. Evaluar si la partida es válida (reinicios, abandonos, partidas cortas)
        const verdict = evaluateMatch(gameData, players, schemaVersion);
        if (verdict.voided) {
            console.log(`🚫 Partida ${gameId} anulada (${verdict.reason}) — se guarda sin publicar`);
            await supabase.saveGame(gameData, players, {
                isVoided: true,
                voidReason: verdict.reason,
                schemaVersion,
                clientVersion
            });
            return res.json({
                status: 'voided',
                gameId,
                reason: verdict.reason,
                message: 'Partida anulada (reiniciada o no concluida); no cuenta para stats'
            });
        }

        // 3. Generar PNG
        console.log(`🎨 Generando imagen para partida ${gameId}...`);
        const pngPath = path.join(OUTPUT_DIR, `match_${gameId}.png`);
        await renderer.generatePNG(gameData, players, pngPath);

        if (fs.existsSync(pngPath)) {
            const stats = fs.statSync(pngPath);
            console.log(`   ✅ PNG generado exitosamente: ${pngPath} (${stats.size} bytes)`);
        } else {
            console.error(`   ❌ Falló la generación del PNG: ${pngPath}`);
        }

        // 4. Enviar a Discord
        console.log('💬 Enviando a Discord...');
        const dsResult = await discord.sendImage(pngPath, gameData, players);
        console.log(`   ${dsResult ? '✅' : '❌'} Resultado Discord: ${dsResult ? 'Enviado' : 'Fallido'}`);

        // 5. Guardar en Supabase
        console.log('💾 Guardando en Supabase...');
        await supabase.saveGame(gameData, players, { schemaVersion, clientVersion });

        console.log(`✅ Juego ${gameId} procesado completamente`);

        res.json({
            status: 'processed',
            gameId,
            message: 'Reporte procesado y enviado exitosamente'
        });

    } catch (error) {
        console.error(`❌ Error procesando ${gameId}:`, error.message);
        res.status(500).json({
            status: 'error',
            gameId,
            error: error.message
        });
    }
});



/**
 * Actualizar webhook de Discord
 * POST /api/discord/webhook
 * Body: { webhookUrl: "https://discord.com/api/webhooks/..." }
 */
app.post('/api/discord/webhook', authMiddleware, (req, res) => {
    const { webhookUrl } = req.body;

    if (!webhookUrl) {
        return res.status(400).json({ error: 'Debes proporcionar webhookUrl' });
    }

    discord.setWebhookUrl(webhookUrl);
    res.json({
        status: 'ok',
        message: 'Webhook de Discord actualizado'
    });
});

// ============== ADMIN ENDPOINTS ==============

/**
 * Middleware de administración: requiere header X-Admin-Key.
 * Si ADMIN_KEY no está configurada, los endpoints admin quedan deshabilitados (503).
 */
function adminAuthMiddleware(req, res, next) {
    if (!process.env.ADMIN_KEY) {
        return res.status(503).json({ error: 'Endpoints admin deshabilitados (ADMIN_KEY no configurada)' });
    }
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Admin key inválida' });
    }
    next();
}

/**
 * Resuelve un ID (corto o completo) a un único game_unique_id.
 * Responde el error adecuado y devuelve null si no se puede resolver.
 */
async function resolveGameId(idParam, res) {
    const id = String(idParam || '').trim();
    if (id.length < 6) {
        res.status(400).json({ error: 'El ID debe tener al menos 6 caracteres' });
        return null;
    }

    const matches = await supabase.findGamesByIdPrefix(id);
    if (matches.length === 0) {
        res.status(404).json({ error: `No existe partida con ID '${id}'` });
        return null;
    }
    if (matches.length > 1) {
        res.status(409).json({
            error: `El prefijo '${id}' es ambiguo (${matches.length} coincidencias). Usa más caracteres.`,
            candidates: matches
        });
        return null;
    }
    return matches[0].game_unique_id;
}

/**
 * Eliminar una partida (y sus jugadores) por ID corto o completo.
 * DELETE /api/admin/games/:id
 * Header: X-Admin-Key
 */
app.delete('/api/admin/games/:id', adminAuthMiddleware, async (req, res) => {
    try {
        const fullId = await resolveGameId(req.params.id, res);
        if (!fullId) return;

        await supabase.deleteGame(fullId);
        console.log(`🗑️  [ADMIN] Partida eliminada: ${fullId}`);
        res.json({ status: 'deleted', gameId: fullId });
    } catch (error) {
        console.error('❌ Error en delete admin:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Restaurar una partida anulada (falso positivo del validador).
 * POST /api/admin/games/:id/unvoid
 */
app.post('/api/admin/games/:id/unvoid', adminAuthMiddleware, async (req, res) => {
    try {
        const fullId = await resolveGameId(req.params.id, res);
        if (!fullId) return;

        await supabase.setVoided(fullId, false);
        console.log(`♻️  [ADMIN] Partida restaurada: ${fullId}`);
        res.json({ status: 'unvoided', gameId: fullId });
    } catch (error) {
        console.error('❌ Error en unvoid admin:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Anular manualmente una partida (ej. detectada tarde como reiniciada).
 * POST /api/admin/games/:id/void
 * Body opcional: { reason: "texto" }
 */
app.post('/api/admin/games/:id/void', adminAuthMiddleware, async (req, res) => {
    try {
        const fullId = await resolveGameId(req.params.id, res);
        if (!fullId) return;

        await supabase.setVoided(fullId, true, req.body?.reason || 'manual');
        console.log(`🚫 [ADMIN] Partida anulada manualmente: ${fullId}`);
        res.json({ status: 'voided', gameId: fullId });
    } catch (error) {
        console.error('❌ Error en void admin:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============== DASHBOARD STATS ENDPOINTS ==============

/**
 * Global Stats (Customs Only)
 */
app.get('/api/stats/global', async (req, res) => {
    try {
        const { data: allStats, error: aError } = await supabase.client
            .from('player_stats')
            .select('total_games, total_kills, total_deaths, total_assists');

        if (aError) throw aError;

        const totals = allStats.reduce((acc, curr) => ({
            totalKills: acc.totalKills + curr.total_kills,
            totalDeaths: acc.totalDeaths + curr.total_deaths,
            totalPlayers: acc.totalPlayers + 1
        }), { totalKills: 0, totalDeaths: 0, totalPlayers: 0 });

        // Mismo criterio que las vistas: solo customs válidas
        const { count: gameCount } = await supabase.client
            .from('games')
            .select('*', { count: 'exact', head: true })
            .eq('is_matchmaking', false)
            .eq('is_voided', false);

        res.json({
            ...totals,
            totalGames: gameCount || 0,
            avgKD: totals.totalDeaths > 0 ? (totals.totalKills / totals.totalDeaths).toFixed(2) : totals.totalKills.toFixed(2)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * MVP & Top Performers
 */
app.get('/api/stats/mvp', async (req, res) => {
    try {
        const MIN_GAMES = parseInt(process.env.LEADERBOARD_MIN_GAMES || '5', 10);

        const { data, error } = await supabase.client
            .from('player_stats')
            .select('*');

        if (error) throw error;

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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Leaderboard con métricas MLG Halo 3
 */
app.get('/api/stats/leaderboard', async (req, res) => {
    try {
        const MIN_GAMES = parseInt(req.query.minGames || process.env.LEADERBOARD_MIN_GAMES || '5', 10);
        const limit = parseInt(req.query.limit || '20', 10);
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // Traer TODOS los jugadores: antes se recortaba a top-20 por total_score
        // ANTES de calcular el Slayer Score, excluyendo jugadores injustamente.
        const { data, error } = await supabase.client
            .from('player_stats')
            .select('*');

        if (error) throw error;

        // Calcular métricas MLG para cada jugador
        const mlgLeaderboard = data.map(player => {
            const kda = player.total_deaths > 0
                ? ((player.total_kills + player.total_assists) / player.total_deaths)
                : (player.total_kills + player.total_assists);

            const gamesPlayed = player.total_games || 1;
            const efficiency = (player.total_kills / gamesPlayed) - (player.total_deaths / gamesPlayed);
            const bestSpree = player.best_spree || 0;

            // Componentes normalizados a 0-100 (evita que una métrica domine):
            //  - KDA con tope en 3.0 (un smurf con pocas partidas no rompe la escala)
            //  - Efficiency en rango útil -5..+10 por partida
            //  - Spree con tope en 10 (Killing Frenzy)
            const kdaScore = clamp(kda, 0, 3) / 3 * 100;
            const effScore = clamp((efficiency + 5) / 15, 0, 1) * 100;
            const spreeScore = clamp(bestSpree, 0, 10) / 10 * 100;

            // Slayer Score 0-100: 40% KDA + 30% Efficiency + 30% Spree
            const slayerScore = (kdaScore * 0.4) + (effScore * 0.3) + (spreeScore * 0.3);

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

            return {
                ...player,
                kda: Math.round(kda * 100) / 100,
                efficiency: Math.round(efficiency * 10) / 10,
                avg_spree: bestSpree,
                slayer_score: Math.round(slayerScore * 10) / 10,
                tier,
                tier_color: tierColor,
                is_placement: isPlacement
            };
        });

        // Placement al final; el resto por Slayer Score
        mlgLeaderboard.sort((a, b) =>
            (a.is_placement === b.is_placement)
                ? b.slayer_score - a.slayer_score
                : (a.is_placement ? 1 : -1)
        );

        res.json(mlgLeaderboard.slice(0, limit));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/stats/recent', async (req, res) => {
    try {
        const { data: games, error: gError } = await supabase.client
            .from('recent_games')
            .select('*')
            .limit(10);

        if (gError) throw gError;

        // Fetch players for these games
        const gameIds = games.map(g => g.game_unique_id);

        const { data: players, error: pError } = await supabase.client
            .from('players')
            .select('game_unique_id, gamertag, team_id, score, kills, deaths, assists')
            .in('game_unique_id', gameIds);

        if (pError) throw pError;

        // Group players by game
        const gamesWithPlayers = games.map(game => ({
            ...game,
            players: players.filter(p => p.game_unique_id === game.game_unique_id)
        }));

        res.json(gamesWithPlayers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============== STRIPE PAYMENT ENDPOINTS ==============

/**
 * Create Payment Intent for Stripe donations
 * POST /api/stripe/create-payment-intent
 * Body: { amount: number } // amount in cents
 */
app.post('/api/stripe/create-payment-intent', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(503).json({
                error: 'Stripe is not configured on this server'
            });
        }

        const { amount } = req.body;

        if (!amount || amount < 50) { // Minimum $0.50
            return res.status(400).json({
                error: 'Amount must be at least 50 cents'
            });
        }

        // Create a PaymentIntent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount),
            currency: 'usd',
            automatic_payment_methods: {
                enabled: true,
            },
            metadata: {
                project: 'carnage-reporter',
                purpose: 'donation'
            }
        });

        res.json({
            clientSecret: paymentIntent.client_secret
        });
    } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(500).json({
            error: 'Failed to create payment intent',
            details: error.message
        });
    }
});

// ============== INICIO DEL SERVIDOR ==============

// Servir index.html para cualquier otra ruta (SPA)
app.get('*', (req, res) => {
    const indexPath = path.join(DASHBOARD_DIST, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Dashboard not built');
    }
});

async function start() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║              CARNAGE REPORTER SERVER                     ║');
    console.log('║           Halo 3 MCC Stats - VPS Edition                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Iniciar servidor Express
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 Servidor escuchando en http://0.0.0.0:${PORT}`);
        console.log(`   POST /api/report - Recibir reportes`);
        console.log(`   GET  /api/health - Health check`);
        console.log(`   GET  /api/status - Estado del servidor`);
        console.log('\n👀 Esperando reportes de clientes...\n');
    });


}

// Manejo de cierre graceful
process.on('SIGINT', async () => {
    console.log('\n\n👋 Cerrando servidor...');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n\n👋 Cerrando servidor (SIGTERM)...');
    process.exit(0);
});

start().catch(console.error);
