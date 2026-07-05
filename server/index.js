/**
 * CarnageReporter Server
 * Servidor centralizado para procesar reportes de Halo 3 MCC
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');

// Servicios
const DiscordService = require('./services/discord');
const SupabaseService = require('./services/supabase');
const RendererService = require('./services/renderer');
const WhatsAppService = require('./services/whatsapp');
const { evaluateMatch } = require('./services/validator');
const { startSchedules, WEEKLY_MESSAGE } = require('./services/scheduler');
const { buildCaptionParts, formatRecentGamesWhatsApp } = require('./utils/matchSummary');
const { computeRecords, computeH2H, computePlayerProfile } = require('./utils/records');

// Initialize Stripe
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

const app = express();

// Detrás de Caddy (proxy reverso): confiar en 1 hop para que el rate-limit
// y los logs usen la IP real del cliente, no la del proxy.
app.set('trust proxy', 1);

// Headers de seguridad. CSP desactivado a propósito: el servidor sirve el
// dashboard (Vite) y el modal de Stripe carga js.stripe.com; una CSP estricta
// los rompería. Se conservan noSniff, frameguard, referrer-policy, etc.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// Un reporte 2v2 es pequeño; 256kb es más que suficiente y acota abuso.
app.use(express.json({ limit: '256kb' }));
app.use(cors());

// ---------- Rate limiting ----------
const reportLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60, // 60 reportes por IP cada 15 min
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiados reportes; intenta más tarde.' }
});
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20, // 20 intentos admin por IP cada 15 min (freno a fuerza bruta)
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiados intentos.' }
});
const publicLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120, // 120 lecturas por IP por minuto (dashboard)
    standardHeaders: true, legacyHeaders: false
});

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
const whatsapp = new WhatsAppService();

/**
 * Comparación de secretos en tiempo constante (evita distinguir claves por
 * timing). Ambos lados se hashean a longitud fija antes de comparar para no
 * filtrar la longitud del secreto.
 */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a || '')).digest();
    const hb = crypto.createHash('sha256').update(String(b || '')).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// Middleware de autenticación de clientes (X-API-Key)
function authMiddleware(req, res, next) {
    if (!safeEqual(req.headers['x-api-key'], API_KEY)) {
        return res.status(401).json({ error: 'API key inválida' });
    }
    next();
}

/**
 * Validación básica del payload de /api/report. Rechaza formas inesperadas
 * antes de tocar la BD o el renderer.
 */
function validateReportPayload(gameData, players) {
    if (typeof gameData !== 'object' || gameData === null) return 'gameData inválido';
    if (!Array.isArray(players)) return 'players debe ser un arreglo';
    if (players.length < 1 || players.length > 8) return 'cantidad de jugadores fuera de rango';
    if (typeof gameData.gameUniqueId !== 'string' || gameData.gameUniqueId.length < 1 || gameData.gameUniqueId.length > 255) {
        return 'gameUniqueId inválido';
    }
    for (const p of players) {
        if (typeof p !== 'object' || p === null) return 'jugador inválido';
        if (typeof p.gamertag !== 'string' || p.gamertag.length > 64) return 'gamertag inválido';
        for (const f of ['kills', 'deaths', 'assists', 'score']) {
            if (p[f] !== undefined && !Number.isFinite(Number(p[f]))) return `campo ${f} inválido`;
        }
    }
    return null;
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
app.post('/api/report', reportLimiter, authMiddleware, async (req, res) => {
    const { gameData, players, filename } = req.body;
    const schemaVersion = parseInt(req.body.schemaVersion || 1, 10);
    const clientVersion = req.body.clientVersion || null;

    const validationError = validateReportPayload(gameData, players);
    if (validationError) {
        return res.status(400).json({ error: validationError });
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

        // 3. Matchmaking: se ignora por completo (ni se guarda ni se publica).
        //    Este bot es exclusivamente para customs 2v2 de la comunidad; además
        //    el XML de matchmaking no trae el mapa real en ningún campo fiable
        //    (HopperName es la playlist, ej. "Team Doubles", no un mapa).
        if (gameData.isMatchmaking === true) {
            console.log(`🎮 Partida ${gameId} es matchmaking — ignorada por completo (solo customs 2v2)`);
            return res.json({
                status: 'skipped',
                gameId,
                message: 'Partida de matchmaking ignorada; el bot solo procesa customs 2v2'
            });
        }

        // 4. Generar PNG
        console.log(`🎨 Generando imagen para partida ${gameId}...`);
        const pngPath = path.join(OUTPUT_DIR, `match_${gameId}.png`);
        await renderer.generatePNG(gameData, players, pngPath);

        if (fs.existsSync(pngPath)) {
            const stats = fs.statSync(pngPath);
            console.log(`   ✅ PNG generado exitosamente: ${pngPath} (${stats.size} bytes)`);
        } else {
            console.error(`   ❌ Falló la generación del PNG: ${pngPath}`);
        }

        // 5. Enviar a Discord
        console.log('💬 Enviando a Discord...');
        const dsResult = await discord.sendImage(pngPath, gameData, players);
        console.log(`   ${dsResult ? '✅' : '❌'} Resultado Discord: ${dsResult ? 'Enviado' : 'Fallido'}`);

        // 5b. Enviar a WhatsApp (si está habilitado y listo; su fallo nunca tumba el request)
        if (whatsapp.isReady()) {
            const { winnerLine, mapName, dateStr, timeStr, shortId } = buildCaptionParts(gameData, players);
            // WhatsApp usa *asterisco simple* para negritas (no ** como Discord/Markdown)
            const waCaption = `🏆 *${winnerLine}*\n${mapName}\n📅 ${dateStr} ${timeStr} hrs (CDMX)\nID: ${shortId}`;
            const waResult = await whatsapp.sendImage(pngPath, waCaption);
            console.log(`   ${waResult ? '✅' : '❌'} Resultado WhatsApp: ${waResult ? 'Enviado' : 'Fallido'}`);
        }

        // 6. Guardar en Supabase
        console.log('💾 Guardando en Supabase...');
        await supabase.saveGame(gameData, players, { schemaVersion, clientVersion });

        console.log(`✅ Juego ${gameId} procesado completamente`);

        res.json({
            status: 'processed',
            gameId,
            message: 'Reporte procesado y enviado exitosamente'
        });

    } catch (error) {
        console.error(`❌ Error procesando ${gameId}:`, error);
        res.status(500).json({
            status: 'error',
            gameId,
            error: 'Error interno procesando el reporte'
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
    if (!safeEqual(req.headers['x-admin-key'], process.env.ADMIN_KEY)) {
        return res.status(401).json({ error: 'Admin key inválida' });
    }
    next();
}

// Todos los endpoints admin pasan por el rate limiter (freno a fuerza bruta)
app.use('/api/admin', adminLimiter);
// Endpoints públicos de lectura (dashboard)
app.use('/api/stats', publicLimiter);

/**
 * Resuelve un ID (corto o completo) a un único game_unique_id.
 * Responde el error adecuado y devuelve null si no se puede resolver.
 */
async function resolveGameId(idParam, res) {
    // Aceptar solo caracteres válidos de un UUID/ID (bloquea comodines de LIKE % _)
    const id = String(idParam || '').trim();
    if (!/^[a-zA-Z0-9-]{6,64}$/.test(id)) {
        res.status(400).json({ error: 'ID inválido (mínimo 6 caracteres alfanuméricos)' });
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
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
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
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
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
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============== ADMIN: WHATSAPP ==============

/**
 * QR de pairing como imagen PNG (abrir en el navegador y escanear).
 * 204 si no hay QR pendiente (ya emparejado o servicio apagado).
 * GET /api/admin/whatsapp/qr
 */
app.get('/api/admin/whatsapp/qr', adminAuthMiddleware, async (req, res) => {
    try {
        const qr = whatsapp.getQR();
        if (!qr) {
            return res.status(204).end();
        }
        const QRCode = require('qrcode');
        const png = await QRCode.toBuffer(qr, { width: 400, margin: 2 });
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(png);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Estado del servicio de WhatsApp.
 * GET /api/admin/whatsapp/status
 */
app.get('/api/admin/whatsapp/status', adminAuthMiddleware, (req, res) => {
    res.json(whatsapp.getStatus());
});

/**
 * Lista de grupos disponibles (para obtener el WHATSAPP_GROUP_ID).
 * GET /api/admin/whatsapp/groups
 */
app.get('/api/admin/whatsapp/groups', adminAuthMiddleware, async (req, res) => {
    try {
        const groups = await whatsapp.listGroups();
        res.json(groups);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Dispara AHORA el mensaje semanal (para probar sin esperar al lunes).
 * POST /api/admin/whatsapp/test-weekly
 */
app.post('/api/admin/whatsapp/test-weekly', adminAuthMiddleware, async (req, res) => {
    if (!whatsapp.isReady()) {
        return res.status(503).json({ error: 'WhatsApp no está listo' });
    }
    const ok = await whatsapp.sendMessage(WEEKLY_MESSAGE);
    res.json({ status: ok ? 'sent' : 'failed', message: WEEKLY_MESSAGE });
});

/**
 * Vista previa del texto del comando !partidas SIN enviarlo al grupo.
 * GET /api/admin/whatsapp/preview-partidas
 */
app.get('/api/admin/whatsapp/preview-partidas', adminAuthMiddleware, async (req, res) => {
    try {
        const games = await supabase.getRecentGamesWithPlayers(10);
        res.type('text/plain').send(formatRecentGamesWhatsApp(games));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
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
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
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
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Leaderboard con métricas MLG Halo 3
 */
app.get('/api/stats/leaderboard', async (req, res) => {
    try {
        const clampInt = (v, def, lo, hi) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : def;
        };
        const MIN_GAMES = clampInt(req.query.minGames ?? process.env.LEADERBOARD_MIN_GAMES, 5, 0, 1000);
        const limit = clampInt(req.query.limit, 20, 1, 100);
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // Traer TODOS los jugadores: antes se recortaba a top-20 por total_score
        // ANTES de calcular el Slayer Score, excluyendo jugadores injustamente.
        const { data, error } = await supabase.client
            .from('player_stats')
            .select('*');

        if (error) throw error;

        // Récord V-D-E por jugador (calculado desde las partidas)
        const allGames = await supabase.getAllValidGamesWithPlayers();
        const records = computeRecords(allGames);

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
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/api/stats/recent', async (req, res) => {
    try {
        const gamesWithPlayers = await supabase.getRecentGamesWithPlayers(10);
        res.json(gamesWithPlayers);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Lista simple de jugadores (para buscadores/selectores del dashboard)
 */
app.get('/api/stats/players', async (req, res) => {
    try {
        const { data, error } = await supabase.client
            .from('player_stats')
            .select('gamertag, total_games')
            .order('gamertag', { ascending: true });
        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Head-to-head entre dos jugadores: como rivales y como dupla.
 * GET /api/stats/h2h?p1=<gamertag>&p2=<gamertag>
 */
app.get('/api/stats/h2h', async (req, res) => {
    try {
        const { p1, p2 } = req.query;
        if (!p1 || !p2) {
            return res.status(400).json({ error: 'Faltan p1 y/o p2' });
        }
        if (String(p1).toLowerCase() === String(p2).toLowerCase()) {
            return res.status(400).json({ error: 'Elige dos jugadores distintos' });
        }
        const games = await supabase.getAllValidGamesWithPlayers();
        res.json(computeH2H(games, p1, p2));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Perfil de un jugador: totales, récord V-D-E e historial de partidas.
 * GET /api/stats/player/:gamertag
 */
app.get('/api/stats/player/:gamertag', async (req, res) => {
    try {
        const games = await supabase.getAllValidGamesWithPlayers();
        const profile = computePlayerProfile(games, req.params.gamertag);
        if (!profile) {
            return res.status(404).json({ error: `No hay partidas de '${req.params.gamertag}'` });
        }
        res.json(profile);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============== STRIPE PAYMENT ENDPOINTS ==============

/**
 * Create Payment Intent for Stripe donations
 * POST /api/stripe/create-payment-intent
 * Body: { amount: number } // amount in cents
 */
app.post('/api/stripe/create-payment-intent', publicLimiter, async (req, res) => {
    try {
        if (!stripe) {
            return res.status(503).json({
                error: 'Stripe is not configured on this server'
            });
        }

        const amount = Number(req.body?.amount);

        // Entre $0.50 y $1,000 (evita PaymentIntents absurdos / abuso de la API)
        if (!Number.isFinite(amount) || amount < 50 || amount > 100000) {
            return res.status(400).json({
                error: 'Amount must be between 50 and 100000 cents'
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
            error: 'Failed to create payment intent'
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

    // Inicializar WhatsApp en segundo plano (no bloquea el arranque de Express)
    whatsapp.initialize().catch(err => {
        console.error('❌ WhatsApp no pudo inicializar:', err.message);
    });

    // Comando del grupo: !partidas -> últimas 10 partidas formateadas
    whatsapp.registerCommand('!partidas', async () => {
        const games = await supabase.getRecentGamesWithPlayers(10);
        return formatRecentGamesWhatsApp(games);
    });

    // Tareas programadas (mensaje semanal de los lunes, solo WhatsApp)
    startSchedules(whatsapp);
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
