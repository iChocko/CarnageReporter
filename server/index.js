/**
 * CarnageReporter Server
 * Servidor centralizado para procesar reportes de Halo 3 MCC
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// Servicios
const DiscordService = require('./services/discord');
const SupabaseService = require('./services/supabase');
const RendererService = require('./services/renderer');

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
const API_KEY = process.env.API_KEY || 'h3mcc-carnage-2024-secret';

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

    if (!gameData || !players) {
        return res.status(400).json({ error: 'Faltan gameData o players' });
    }

    const gameId = gameData.gameUniqueId;
    console.log(`\n📥 Recibido reporte: ${gameId} (${gameData.mapName})`);
    console.log(`   📋 gameData completo:`, JSON.stringify(gameData, null, 2));
    console.log(`   👥 players (${players.length}):`, JSON.stringify(players.slice(0, 2), null, 2));

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

        // 2. Generar PNG
        console.log(`🎨 Generando imagen para partida ${gameId}...`);
        const pngPath = path.join(OUTPUT_DIR, `match_${gameId}.png`);
        await renderer.generatePNG(gameData, players, pngPath);

        if (fs.existsSync(pngPath)) {
            const stats = fs.statSync(pngPath);
            console.log(`   ✅ PNG generado exitosamente: ${pngPath} (${stats.size} bytes)`);
        } else {
            console.error(`   ❌ Falló la generación del PNG: ${pngPath}`);
        }

        // 3. Enviar a Discord
        console.log('💬 Enviando a Discord...');
        const dsResult = await discord.sendImage(pngPath, gameData, players);
        console.log(`   ${dsResult ? '✅' : '❌'} Resultado Discord: ${dsResult ? 'Enviado' : 'Fallido'}`);

        // 4. Guardar en Supabase
        console.log('💾 Guardando en Supabase...');
        await supabase.saveGame(gameData, players);

        // 5. Limpiar PNG temporal (opcional, mantener para debug)
        // fs.unlinkSync(pngPath);

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

        // Count only customs (non-matchmaking)
        const { count: gameCount } = await supabase.client
            .from('games')
            .select('*', { count: 'exact', head: true })
            .eq('is_matchmaking', false);

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
        const { data, error } = await supabase.client
            .from('player_stats')
            .select('*')
            .limit(100);

        if (error) throw error;

        // Find MVP (best overall KD with minimum 5 games)
        const eligiblePlayers = data.filter(p => p.total_games >= 5);
        const mvp = eligiblePlayers.sort((a, b) => b.overall_kd - a.overall_kd)[0];

        // Top Slayer (most kills)
        const topSlayer = [...data].sort((a, b) => b.total_kills - a.total_kills)[0];

        // Best Support (most assists)
        const topSupport = [...data].sort((a, b) => b.total_assists - a.total_assists)[0];

        // Spree King (best killing spree)
        const spreeKing = [...data].sort((a, b) => b.best_spree - a.best_spree)[0];

        // Most Active (most games played)
        const mostActive = [...data].sort((a, b) => b.total_games - a.total_games)[0];

        res.json({
            mvp: mvp || null,
            topSlayer: topSlayer || null,
            topSupport: topSupport || null,
            spreeKing: spreeKing || null,
            mostActive: mostActive || null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Leaderboard
 */
app.get('/api/stats/leaderboard', async (req, res) => {
    try {
        const { data, error } = await supabase.client
            .from('player_stats')
            .select('*')
            .limit(20);

        if (error) throw error;
        res.json(data);
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
