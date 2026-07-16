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
const { buildCaptionParts, formatRecentGamesWhatsApp, sanitizeCaptionText } = require('./utils/matchSummary');
const { computeRecords, computeH2H, computePlayerProfile, aggregatePlayers, computeSlayerScore, computeDuoRecords } = require('./utils/records');
const teams = require('./utils/teams');
const rosterStore = require('./utils/roster');
const { currentOrLastSession, formatRondasMessage, formatLiveRoundUpdate, lineupOf, SESSION_GAP_MINUTES } = require('./utils/sessions');
const { getResetTs, setResetTs, filterGamesAfterReset } = require('./utils/rondasReset');
const forfeits = require('./utils/forfeits');
const anuladas = require('./utils/anuladas');
const { computeSaldos, formatSaldosMessage, getLastCorteTs, setLastCorteTs, isSameCdmxDay } = require('./utils/saldos');
const { classifyFormat, FORMATS } = require('./utils/format');
const { resolveMap, MAP_NAMES } = require('./utils/maps');

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

/**
 * Partidas 2v2 que cuentan para el marcador de rondas: todas las válidas
 * más los W.O. (partidas dadas por perdida, virtuales — no tocan stats),
 * menos las anteriores al último "!rondas reset" (siguen en las stats).
 */
async function getRondasGames() {
    const games = await supabase.getAllValidGamesWithPlayers('2v2');
    const merged = [...games, ...forfeits.loadForfeitGames(OUTPUT_DIR)]
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return filterGamesAfterReset(merged, OUTPUT_DIR);
}

/**
 * Partidas que cuentan para el CORTE SEMANAL. A diferencia del marcador,
 * la ventana arranca en el último corte, NO en el último "!rondas reset":
 * el reset (abierto a todo el grupo) limpia el marcador visible, pero las
 * deudas de la semana persisten hasta que el corte del lunes las cobra.
 * Si nunca ha habido corte (estreno de la función) se cae al último reset.
 */
async function getSaldosGames() {
    const games = await supabase.getAllValidGamesWithPlayers('2v2');
    const merged = [...games, ...forfeits.loadForfeitGames(OUTPUT_DIR)]
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const sinceTs = getLastCorteTs(OUTPUT_DIR) ?? getResetTs(OUTPUT_DIR);
    if (!sinceTs) return merged;
    return merged.filter(g => new Date(g.timestamp).getTime() > sinceTs);
}

// Inicializar servicios
const discord = new DiscordService(); // 2v2 -> canal Retas H3
const discord4v4 = new DiscordService(process.env.DISCORD_WEBHOOK_URL_4V4); // 4v4 -> canal de validación
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

        // 2. Resolver el mapa del lado servidor (el cliente v1.5.0 manda mapCode
        //    sacado del film de autosave; el XML solo no trae el mapa).
        //    Códigos desconocidos -> placeholder + se guarda el código para mapearlo.
        const mapResolved = resolveMap({
            mapCode: gameData.mapCode,
            filename,
            mapName: gameData.mapName
        });
        gameData.mapName = mapResolved.mapName;
        const mapCode = mapResolved.mapCode;

        // 3. Clasificar formato (2v2 / 4v4 / null)
        const format = classifyFormat(players);
        const saveMeta = { schemaVersion, clientVersion, mapCode, format };

        // 4. Evaluar validez (formato no soportado, reinicios, abandonos, cortas)
        const verdict = evaluateMatch(gameData, players, schemaVersion);
        if (verdict.voided) {
            console.log(`🚫 Partida ${gameId} anulada (${verdict.reason}) — se guarda sin publicar`);
            await supabase.saveGame(gameData, players, { ...saveMeta, isVoided: true, voidReason: verdict.reason });
            return res.json({
                status: 'voided', gameId, reason: verdict.reason,
                message: 'Partida anulada; no cuenta para stats'
            });
        }

        // 5. 2v2 en matchmaking se ignora (solo customs 2v2). 4v4 sí acepta matchmaking.
        if (format === '2v2' && gameData.isMatchmaking === true) {
            console.log(`🎮 Partida ${gameId} es 2v2 matchmaking — ignorada (2v2 solo customs)`);
            return res.json({
                status: 'skipped', gameId,
                message: 'Partida 2v2 de matchmaking ignorada'
            });
        }

        // 6. Generar PNG
        console.log(`🎨 Generando imagen ${format} para partida ${gameId} (${gameData.mapName})...`);
        const pngPath = path.join(OUTPUT_DIR, `match_${gameId}.png`);
        await renderer.generatePNG(gameData, players, pngPath);

        // 7. Publicar según formato:
        //    2v2 -> Discord(Retas H3) + WhatsApp(Retas H3)
        //    4v4 -> Discord(validación) + WhatsApp(Torneos Halo 3)
        if (format === '2v2') {
            const dsResult = await discord.sendImage(pngPath, gameData, players);
            console.log(`   ${dsResult ? '✅' : '❌'} Discord: ${dsResult ? 'Enviado' : 'Fallido'}`);
        }

        if (format === '4v4') {
            const ds4Result = await discord4v4.sendImage(pngPath, gameData, players);
            console.log(`   ${ds4Result ? '✅' : '❌'} Discord (4v4): ${ds4Result ? 'Enviado' : 'Fallido'}`);
        }

        if (whatsapp.isReady()) {
            const chatId = whatsapp.groupIdFor(format);
            if (chatId) {
                const { winnerLine, mapLine, dateStr, timeStr, shortId } = buildCaptionParts(gameData, players);
                const waCaption = `🏆 *${winnerLine}*\n${mapLine}\n${dateStr} ${timeStr} hrs (CDMX)\nID: ${shortId}`;
                const waResult = await whatsapp.sendImage(pngPath, waCaption, chatId);
                console.log(`   ${waResult ? '✅' : '❌'} WhatsApp (${format}): ${waResult ? 'Enviado' : 'Fallido'}`);
            } else {
                console.log(`   ⚠️  Sin grupo de WhatsApp configurado para ${format}`);
            }
        }

        // 8. Guardar en Supabase
        await supabase.saveGame(gameData, players, saveMeta);
        console.log(`✅ Juego ${gameId} (${format}) procesado completamente`);

        // 9. Anuncio automático del marcador de la ronda (Bo3) en el grupo 2v2:
        //    cómo va la ronda en curso, o su cierre si alguien llegó a 2.
        if (format === '2v2' && whatsapp.isReady()) {
            const chatId = whatsapp.groupIdFor('2v2');
            if (chatId) {
                try {
                    const rondasGames = await getRondasGames();
                    const update = formatLiveRoundUpdate(currentOrLastSession(rondasGames));
                    if (update) {
                        const okRonda = await whatsapp.sendMessage(update, chatId);
                        console.log(`   ${okRonda ? '✅' : '❌'} WhatsApp (marcador ronda): ${okRonda ? 'Enviado' : 'Fallido'}`);
                    }
                } catch (e) {
                    // El marcador es un extra: si falla, la partida ya quedó publicada y guardada
                    console.error(`   ⚠️  Marcador de ronda falló: ${e.message}`);
                }
            }
        }

        res.json({ status: 'processed', gameId, format, message: 'Reporte procesado' });

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
    const chatId = whatsapp.groupIdFor('2v2');
    if (!chatId) return res.status(503).json({ error: 'Sin grupo 2v2 configurado' });
    const ok = await whatsapp.sendMessage(WEEKLY_MESSAGE, chatId);
    res.json({ status: ok ? 'sent' : 'failed', message: WEEKLY_MESSAGE });
});

/**
 * Vista previa del comando !equipos SIN enviarlo al grupo.
 * GET /api/admin/whatsapp/preview-equipos?format=2v2|4v4&players=A,B,C,D
 * Con &mentions=A,B,C,D simula jugadores ya resueltos desde menciones
 * (ejercita la regla de exactamente 4 y la respuesta de emparejamientos).
 */
app.get('/api/admin/whatsapp/preview-equipos', adminAuthMiddleware, async (req, res) => {
    try {
        const format = FORMATS.includes(req.query.format) ? req.query.format : '2v2';
        const mentionTags = String(req.query.mentions || '').split(',').map(s => s.trim()).filter(Boolean);
        const reply = await buildEquiposReply(format, String(req.query.players || ''), mentionTags, {
            fromMentions: mentionTags.length > 0
        });
        res.type('text/plain').send(reply);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Participantes del grupo de WhatsApp de un formato, con nombre visible y
 * ambas formas de JID (número y LID). Para el bootstrap del roster.
 * GET /api/admin/whatsapp/participants?format=2v2|4v4
 */
app.get('/api/admin/whatsapp/participants', adminAuthMiddleware, async (req, res) => {
    try {
        if (!whatsapp.isReady()) return res.status(503).json({ error: 'WhatsApp no está listo' });
        const format = FORMATS.includes(req.query.format) ? req.query.format : '2v2';
        res.json(await whatsapp.getGroupParticipants(format));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Roster número ↔ gamertag persistido.
 * GET  /api/admin/whatsapp/roster            -> estado actual
 * POST /api/admin/whatsapp/roster            -> siembra/actualiza vínculos
 *      Body: { links: [{ jids: ["521...@c.us", ...], gamertag, known? }], replace? }
 *      Con replace=true sustituye el roster completo; si no, hace merge.
 */
app.get('/api/admin/whatsapp/roster', adminAuthMiddleware, (req, res) => {
    res.json(rosterStore.loadRoster(OUTPUT_DIR));
});

/**
 * W.O. declarados con !perdida (partidas virtuales del marcador de rondas).
 * GET /api/admin/whatsapp/forfeits
 */
app.get('/api/admin/whatsapp/forfeits', adminAuthMiddleware, (req, res) => {
    res.json(forfeits.loadForfeits(OUTPUT_DIR));
});

/**
 * Corte semanal de saldos: arma el mensaje con las deudas netas por
 * alineación desde el último reset, con menciones desde el roster.
 * @returns {{payload: {text, mentions}|null, gamesCount: number}}
 */
async function buildSaldosPayload() {
    const games = await getSaldosGames();
    const saldos = computeSaldos(games);

    const data = rosterStore.loadRoster(OUTPUT_DIR);
    const jidByTagLower = new Map();
    for (const link of data.links) {
        const phone = link.jids.find(j => j.endsWith('@c.us')) || link.jids[0];
        if (phone) jidByTagLower.set(link.gamertag.toLowerCase(), phone);
    }

    return { payload: formatSaldosMessage(saldos, games.length, jidByTagLower), gamesCount: games.length };
}

/**
 * Job de los lunes: manda los saldos al grupo 2v2 y, SOLO si el mensaje se
 * confirmó enviado, reinicia el marcador. El cron reintenta cada hora hasta
 * las 23:00 por si el servidor estaba reiniciando a las 09:00; el marcador
 * de corte diario evita repetirlo una vez hecho. Si WhatsApp está caído las
 * deudas no se pierden (sin reset); POST .../send-saldos lo corre a mano.
 * @param {{force?: boolean, skipReset?: boolean}} [opts] - force salta el
 *   guard de "ya corrido hoy"; skipReset manda el mensaje real pero NO
 *   toca el marcador de rondas ni el de corte diario (para probar en vivo
 *   sin adelantar el corte de la semana).
 */
const withSaldosLock = makeLock();
async function sendWeeklySaldos({ force = false, skipReset = false } = {}) {
    return withSaldosLock(async () => {
        const last = getLastCorteTs(OUTPUT_DIR);
        if (!force && !skipReset && last && isSameCdmxDay(last, Date.now())) {
            return { sent: false, reason: 'corte_ya_hecho_hoy' };
        }

        // El corte se fija ANTES de leer las partidas: lo que caiga durante
        // el envío no se anuncia hoy, pero queda pendiente para el próximo
        // corte en lugar de borrarse sin haberse anunciado.
        const cutTs = Date.now();
        const { payload, gamesCount } = await buildSaldosPayload();
        if (!payload) {
            if (!skipReset) setLastCorteTs(OUTPUT_DIR, cutTs); // semana sin retas: corte trivial
            return { sent: false, reason: 'sin_retas_pendientes', gamesCount };
        }

        if (!whatsapp.isReady()) return { sent: false, reason: 'whatsapp_no_listo', gamesCount };
        const chatId = whatsapp.groupIdFor('2v2');
        if (!chatId) return { sent: false, reason: 'sin_grupo_2v2', gamesCount };

        // waitUntilMsgSent: esperar la confirmación del servidor de WhatsApp,
        // no solo el encolado local — el reset borra deudas y exige certeza.
        const options = { waitUntilMsgSent: true };
        if (payload.mentions.length) options.mentions = payload.mentions;
        const ok = await whatsapp.sendMessage(payload.text, chatId, options);
        if (ok && skipReset) return { sent: true, reset: false, skipped: true, gamesCount };
        if (ok) {
            setResetTs(OUTPUT_DIR, cutTs);
            setLastCorteTs(OUTPUT_DIR, cutTs);
        }
        return { sent: ok, reset: ok, gamesCount };
    });
}

/**
 * Vista previa del corte semanal SIN enviarlo ni reiniciar nada.
 * GET /api/admin/whatsapp/preview-saldos
 */
app.get('/api/admin/whatsapp/preview-saldos', adminAuthMiddleware, async (req, res) => {
    try {
        const { payload, gamesCount } = await buildSaldosPayload();
        res.type('text/plain').send(payload ? payload.text : `(sin retas pendientes: ${gamesCount} partidas)`);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Dispara AHORA el corte semanal: envío real al grupo + reset del marcador.
 * Para correrlo a mano si el cron del lunes se perdió por un reinicio, o
 * para probar el envío real sin adelantar el corte (Body: { skipReset: true }
 * — manda el mensaje real pero deja el marcador de rondas intacto).
 * POST /api/admin/whatsapp/send-saldos
 */
app.post('/api/admin/whatsapp/send-saldos', adminAuthMiddleware, async (req, res) => {
    try {
        res.json(await sendWeeklySaldos({
            force: req.body?.force === true,
            skipReset: req.body?.skipReset === true
        }));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Anuncio operativo al grupo (avisos de nuevas versiones del cliente, etc.).
 * POST /api/admin/whatsapp/announce  Body: { text, format? ('2v2'|'4v4') }
 */
app.post('/api/admin/whatsapp/announce', adminAuthMiddleware, async (req, res) => {
    try {
        const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
        if (!text) return res.status(400).json({ error: 'Falta text' });
        if (text.length > 4000) return res.status(400).json({ error: 'Texto demasiado largo' });
        // El bot procesa sus propios mensajes (message_create): un anuncio que
        // empiece con "!" dispararía un comando en bucle.
        if (text.startsWith('!')) return res.status(400).json({ error: 'El anuncio no puede empezar con "!"' });
        if (!whatsapp.isReady()) return res.status(503).json({ error: 'WhatsApp no está listo' });
        const format = req.body?.format === '4v4' ? '4v4' : '2v2';
        const chatId = whatsapp.groupIdFor(format);
        if (!chatId) return res.status(503).json({ error: `Sin grupo ${format} configurado` });
        const ok = await whatsapp.sendMessage(text, chatId, { waitUntilMsgSent: true });
        res.json({ sent: ok, format });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

const JID_SHAPE = /^\d{5,20}@(c\.us|lid)$/;

app.post('/api/admin/whatsapp/roster', adminAuthMiddleware, async (req, res) => {
    try {
        const links = Array.isArray(req.body?.links) ? req.body.links : null;
        if (!links) return res.status(400).json({ error: 'Body esperado: { links: [{ jids, gamertag }] }' });
        if (links.length > 100) return res.status(400).json({ error: 'Máximo 100 vínculos por llamada' });

        const payload = await withRosterLock(async () => {
            const data = req.body.replace === true
                ? { version: 1, links: [] }
                : rosterStore.loadRoster(OUTPUT_DIR);

            const results = [];
            for (const raw of links) {
                const jids = (Array.isArray(raw?.jids) ? raw.jids : [raw?.jid])
                    .filter(Boolean).map(String).filter(j => JID_SHAPE.test(j));
                const gamertag = sanitizeCaptionText(String(raw?.gamertag || '')).trim();
                if (!jids.length || !gamertag || gamertag.length > MAX_TAG_LEN || gamertag.startsWith('!')) {
                    results.push({ gamertag: gamertag || null, ok: false, error: 'jids con forma inválida y/o gamertag inválido' });
                    continue;
                }
                const result = rosterStore.linkJid(data, jids[0], gamertag, {
                    known: raw?.known !== false,
                    by: 'admin-api'
                });
                if (result.ok) {
                    for (const alias of jids.slice(1)) rosterStore.addAlias(result.link, alias);
                }
                results.push({ gamertag, ok: result.ok, conflict: result.conflict?.gamertag });
            }

            rosterStore.saveRoster(OUTPUT_DIR, data);
            return { status: 'ok', total: data.links.length, results };
        });
        res.json(payload);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Vista previa del comando !rondas SIN enviarlo al grupo.
 * GET /api/admin/whatsapp/preview-rondas
 */
app.get('/api/admin/whatsapp/preview-rondas', adminAuthMiddleware, async (req, res) => {
    try {
        const games = await getRondasGames();
        res.type('text/plain').send(formatRondasMessage(currentOrLastSession(games)));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Vista previa del texto del comando !partidas SIN enviarlo al grupo.
 * GET /api/admin/whatsapp/preview-partidas?format=2v2|4v4
 */
app.get('/api/admin/whatsapp/preview-partidas', adminAuthMiddleware, async (req, res) => {
    try {
        const format = FORMATS.includes(req.query.format) ? req.query.format : '2v2';
        const games = await supabase.getRecentGamesWithPlayers(10, format);
        res.type('text/plain').send(formatRecentGamesWhatsApp(games));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Arma la respuesta del comando !equipos: divide la lista de jugadores en dos
 * equipos parejos según el skill del formato del grupo (con fallback al otro
 * formato y a la media). Función compartida por el comando de WhatsApp y el
 * endpoint admin de prueba.
 *
 * En 2v2 con exactamente 4 jugadores evalúa los 3 emparejamientos posibles
 * (con ajuste por duplas con historial) y responde el más parejo + alternativas.
 * @param {string[]} mentionTags - gamertags ya resueltos desde menciones
 * @param {boolean} fromMentions - aplica la regla de exactamente 4 (solo 2v2)
 */
const OTHER_FORMAT = { '2v2': '4v4', '4v4': '2v2' };
const EQUIPOS_USAGE = 'Uso: !caracola @P1 @P2 @P3 @P4 — también acepto gamertags escritos o mezcla: !caracola @P1 @P2 Fulano, Invitado';

async function buildEquiposReply(format, args, mentionTags = [], { fromMentions = false, mentionJidByLower = null } = {}) {
    const [primaryGames, secondaryGames] = await Promise.all([
        supabase.getAllValidGamesWithPlayers(format),
        supabase.getAllValidGamesWithPlayers(OTHER_FORMAT[format])
    ]);
    const primary = teams.computeSkillIndex(primaryGames);
    const secondary = teams.computeSkillIndex(secondaryGames);

    // Diccionario de gamertags conocidos (ambos formatos) para parsear la lista
    const knownByLower = new Map();
    for (const idx of [secondary, primary]) { // primary al final: tiene prioridad
        for (const [lower, v] of idx.byLower) knownByLower.set(lower, v.name);
    }

    const typedNames = teams.parsePlayerList(teams.stripMentionTokens(args), knownByLower);
    // Sanitizar TODO lo que se va a eco en la respuesta (texto del usuario y
    // tags canónicos que pudieran venir contaminados desde la BD)
    const names = [...mentionTags, ...typedNames].map(n => sanitizeCaptionText(n)).filter(Boolean);

    const exactRule = fromMentions && format === '2v2' ? { exact: 4 } : {};
    const validation = teams.validateRoster(names, exactRule);
    if (!validation.ok) return validation.error;

    const roster = teams.resolveRoster(validation.roster, primary, secondary);

    // 2v2 con 4 jugadores: los 3 emparejamientos posibles, del más parejo al menos
    if (format === '2v2' && roster.length === 4) {
        const duoRecords = computeDuoRecords(primaryGames);
        const ranked = teams.rankPairings(roster, duoRecords);
        return teams.formatPairingsMessage(roster, ranked, mentionJidByLower);
    }

    const result = teams.balanceTeams(roster);
    return teams.formatTeamsMessage(format, roster, result, mentionJidByLower);
}

// Las mutaciones de archivos compartidos (roster, W.O.) son lee-modifica-
// escribe con awaits en medio; estos candados en proceso las serializan para
// que dos comandos casi simultáneos no se pisen los datos.
function makeLock() {
    let queue = Promise.resolve();
    return function withLock(fn) {
        const run = queue.then(fn, fn);
        queue = run.then(() => undefined, () => undefined);
        return run;
    };
}
const withRosterLock = makeLock();
const withForfeitLock = makeLock();
const withAnularLock = makeLock();

const MAX_TAG_LEN = 32;         // los gamertags de Xbox no pasan de ~16; techo holgado
const MAX_MENTION_TARGETS = 20; // techo duro de menciones; validateRoster ya limita a 16

/** Últimos 4 dígitos de un JID con forma válida, o '' si no la tiene. */
function jidDigits(jid) {
    return ((String(jid).match(/^(\d{4,})@/) || [])[1] || '').slice(-4);
}

/**
 * Resuelve los JIDs mencionados a gamertags vía el roster persistente.
 * Aprende la forma alterna de JID (LID/teléfono) cuando el puente responde,
 * con UNA sola llamada al puente para todos los faltantes.
 * @returns {{tags: string[], unresolvedDisplays: string[], botMentioned: boolean}}
 */
async function resolveMentionsToTags(mentionedIds) {
    const own = whatsapp.getOwnIds();
    const seen = new Set();
    const jids = [];
    let botMentioned = false;
    for (const jid of mentionedIds || []) {
        if (own.has(jid)) { botMentioned = true; continue; }
        if (!seen.has(jid)) { seen.add(jid); jids.push(jid); }
    }

    const { linkByJid, pairByJid } = await withRosterLock(async () => {
        const data = rosterStore.loadRoster(OUTPUT_DIR);
        const found = new Map();
        const misses = [];
        for (const jid of jids) {
            const link = rosterStore.findByJid(data, jid);
            if (link) found.set(jid, link);
            else misses.push(jid);
        }
        const pairs = new Map();
        if (misses.length) {
            // La persona puede estar registrada con la otra forma de JID
            const resolved = await whatsapp.resolveLidPn(misses);
            let learned = false;
            misses.forEach((jid, i) => {
                const pair = resolved[i] || {};
                pairs.set(jid, pair);
                for (const alt of [pair.lid, pair.pn].filter(Boolean)) {
                    const link = rosterStore.findByJid(data, alt);
                    if (link) { rosterStore.addAlias(link, jid); found.set(jid, link); learned = true; break; }
                }
            });
            if (learned) rosterStore.saveRoster(OUTPUT_DIR, data);
        }
        return { linkByJid: found, pairByJid: pairs };
    });

    const tags = [];
    const unresolved = [];
    const jidByTagLower = new Map(); // para que la respuesta mencione de vuelta
    for (const jid of jids) {
        const link = linkByJid.get(jid);
        if (link) {
            tags.push(link.gamertag);
            jidByTagLower.set(link.gamertag.toLowerCase(), jid);
        } else {
            unresolved.push(jid);
        }
    }

    // Nombre visible de los no registrados (best effort; nunca tumba el comando).
    // OJO: si la mención llegó como @lid, WhatsApp Web no siempre trae el
    // pushname para esa forma — se prefiere la forma @c.us (del puente
    // LID↔teléfono ya resuelto arriba), que sí lo trae de forma confiable.
    let unresolvedDisplays = [];
    if (unresolved.length) {
        unresolvedDisplays = await Promise.all(unresolved.map(async jid => {
            const phoneForm = pairByJid.get(jid)?.pn || (jid.endsWith('@c.us') ? jid : null);
            const info = await whatsapp.getContactInfo(phoneForm || jid);
            const digits = jidDigits(phoneForm || jid);
            const nombre = sanitizeCaptionText(info.pushname || info.name || '');
            if (nombre && digits) return `${nombre} (…${digits})`;
            if (nombre) return nombre;
            return digits ? `…${digits}` : 'un contacto';
        }));
    }

    return { tags, unresolvedDisplays, botMentioned, jidByTagLower };
}

/**
 * Comando !caracola (alias !equipos) con soporte de menciones: los etiquetados
 * se traducen a gamertag vía el roster y la respuesta los menciona de vuelta;
 * lo escrito a mano sigue funcionando (invitados, sin mención).
 */
async function handleEquiposCommand({ format, args, mentionedIds }) {
    const hasMentions = (mentionedIds || []).length > 0;

    if (!hasMentions) {
        if (!(args || '').trim()) return EQUIPOS_USAGE;
        return buildEquiposReply(format, args);
    }

    // Techo ANTES de resolver: cada mención desconocida cuesta una ida al
    // puente LID↔teléfono; no dejar que un mensaje con 50 tags las pague.
    if (new Set(mentionedIds).size > MAX_MENTION_TARGETS) {
        return 'Máximo 16 jugadores.';
    }

    const { tags, unresolvedDisplays, botMentioned, jidByTagLower } = await resolveMentionsToTags(mentionedIds);

    if (botMentioned && tags.length === 0 && unresolvedDisplays.length === 0 && !teams.stripMentionTokens(args)) {
        return 'Yo no juego, yo reparto. Menciona a los 4 que van a entrar.';
    }

    if (unresolvedDisplays.length) {
        return [
            `Sin registrar: ${unresolvedDisplays.join(', ')}.`,
            'Que manden *!soy <gamertag>* o los vincula un admin con *!vincula @persona <gamertag>*.'
        ].join('\n');
    }

    const text = await buildEquiposReply(format, args, tags, {
        fromMentions: true,
        mentionJidByLower: jidByTagLower
    });

    // Adjuntar las menciones solo si el texto realmente lleva sus tokens
    // (los mensajes de error no los llevan).
    const mentions = [...jidByTagLower.values()].filter(jid => text.includes(`@${String(jid).split('@')[0]}`));
    return mentions.length ? { text, mentions } : text;
}

/**
 * Índice de gamertags conocidos en TODAS las partidas (ambos formatos), para
 * validar registros del roster: lower -> canónico, y partidas por tag.
 */
async function getKnownTagIndex() {
    const [g2, g4] = await Promise.all([
        supabase.getAllValidGamesWithPlayers('2v2'),
        supabase.getAllValidGamesWithPlayers('4v4')
    ]);
    const knownByLower = new Map();
    const gamesByLower = new Map();
    for (const games of [g4, g2]) { // 2v2 al final: tiene prioridad en el nombre canónico
        for (const p of aggregatePlayers(games)) {
            const lower = p.gamertag.toLowerCase();
            knownByLower.set(lower, p.gamertag);
            gamesByLower.set(lower, (gamesByLower.get(lower) || 0) + p.total_games);
        }
    }
    return { knownByLower, gamesByLower };
}

/** ¿El remitente es admin del bot? (el propio teléfono o WHATSAPP_ADMIN_JIDS). */
const ADMIN_JIDS = (process.env.WHATSAPP_ADMIN_JIDS || '').split(',').map(s => s.trim()).filter(Boolean);
async function isAdminSender(senderId, msg) {
    if (msg?.fromMe) return true;
    if (!senderId) return false;
    if (ADMIN_JIDS.includes(senderId)) return true;
    if (!ADMIN_JIDS.length) return false;
    const [pair] = await whatsapp.resolveLidPn([senderId]);
    return [pair?.lid, pair?.pn].filter(Boolean).some(j => ADMIN_JIDS.includes(j));
}

/**
 * Vincula un JID a un gamertag guardando sus dos formas (LID y teléfono).
 * Resuelve las formas ANTES de vincular: si la persona ya está registrada con
 * su otra forma de JID, se cura el alias en lugar de declarar un conflicto
 * falso ("ya está registrado con otro número") o crear un vínculo duplicado.
 * Llamar siempre dentro de withRosterLock.
 */
async function linkWithAliases(data, jid, gamertag, opts) {
    const [pair] = await whatsapp.resolveLidPn([jid]);
    const forms = [...new Set([jid, pair?.lid, pair?.pn].filter(Boolean))];
    for (const form of forms) {
        const existing = rosterStore.findByJid(data, form);
        if (existing) { forms.forEach(f => rosterStore.addAlias(existing, f)); break; }
    }
    const result = rosterStore.linkJid(data, jid, gamertag, opts);
    if (result.ok) {
        forms.forEach(f => rosterStore.addAlias(result.link, f));
        rosterStore.saveRoster(OUTPUT_DIR, data);
    }
    return result;
}

/** Gamertag del remitente según el roster (probando ambas formas de JID). */
async function resolveSenderTag(senderId) {
    if (!senderId) return null;
    const data = rosterStore.loadRoster(OUTPUT_DIR);
    let link = rosterStore.findByJid(data, senderId);
    if (!link) {
        const [pair] = await whatsapp.resolveLidPn([senderId]);
        for (const alt of [pair?.lid, pair?.pn].filter(Boolean)) {
            link = rosterStore.findByJid(data, alt);
            if (link) break;
        }
    }
    return link ? link.gamertag : null;
}

/** Comando !soy <gamertag>: autoregistro número ↔ gamertag. */
async function handleSoyCommand({ format, args, senderId }) {
    const input = sanitizeCaptionText(args || '').trim();

    if (!input) {
        const tag = await resolveSenderTag(senderId);
        if (tag) return `Estás registrado como *${tag}*. Para cambiar: !soy <gamertag>`;
        return 'No estás registrado. Uso: !soy <tu gamertag>';
    }

    let force = false;
    let tagInput = input;
    if (/\sconfirmar$/i.test(tagInput)) {
        force = true;
        tagInput = tagInput.replace(/\sconfirmar$/i, '').trim();
    }
    if (!tagInput) return 'No estás registrado. Uso: !soy <tu gamertag>';
    if (tagInput.length > MAX_TAG_LEN) return 'Ese gamertag no parece válido (muy largo).';
    // Un tag que empieza con "!" podría disparar comandos al ser eco en respuestas
    if (tagInput.startsWith('!')) return 'Ese gamertag no parece válido.';

    const { knownByLower, gamesByLower } = await getKnownTagIndex();
    const match = rosterStore.matchGamertag(tagInput, knownByLower);

    if (match.suggestion && !force) {
        const sugerencia = sanitizeCaptionText(match.suggestion);
        return `No encuentro *${tagInput}*. ¿Quisiste decir *${sugerencia}*? Manda: !soy ${sugerencia}\nSi de verdad es un tag nuevo: !soy ${tagInput} confirmar`;
    }

    const canonical = sanitizeCaptionText(match.exact || tagInput);
    const known = Boolean(match.exact);

    return withRosterLock(async () => {
        const data = rosterStore.loadRoster(OUTPUT_DIR);
        const result = await linkWithAliases(data, senderId, canonical, { known, by: 'self' });

        if (!result.ok && result.conflict) {
            return `*${canonical}* ya está registrado con otro número. Si es un error, que un admin corra: !roster unlink ${canonical}`;
        }
        if (!result.ok) return 'No pude registrarte. Uso: !soy <tu gamertag>';

        if (result.previous) {
            return `Actualizado: ahora eres *${canonical}* (antes ${sanitizeCaptionText(result.previous)}).`;
        }
        if (known) {
            const n = gamesByLower.get(canonical.toLowerCase()) || 0;
            return `Listo: eres *${canonical}* (${n} partida${n !== 1 ? 's' : ''}). Ya te pueden mencionar en !caracola.`;
        }
        return `Registrado: *${canonical}*. Cero partidas todavía: tu rating será provisional hasta que juegues.`;
    });
}

/** Comando !vincula @persona <gamertag>: registro hecho por un admin. */
async function handleVinculaCommand({ args, msg, mentionedIds, senderId }) {
    if (!(await isAdminSender(senderId, msg))) return 'Solo un admin puede hacer eso.';

    const own = whatsapp.getOwnIds();
    const targets = [...new Set(mentionedIds || [])].filter(j => !own.has(j));
    const tagInput = sanitizeCaptionText(teams.stripMentionTokens(args));
    if (targets.length !== 1 || !tagInput) return 'Uso: !vincula @persona <gamertag>';
    if (tagInput.length > MAX_TAG_LEN) return 'Ese gamertag no parece válido (muy largo).';
    if (tagInput.startsWith('!')) return 'Ese gamertag no parece válido.';

    const { knownByLower } = await getKnownTagIndex();
    const match = rosterStore.matchGamertag(tagInput, knownByLower);
    const canonical = sanitizeCaptionText(match.exact || tagInput);
    const known = Boolean(match.exact);

    return withRosterLock(async () => {
        const data = rosterStore.loadRoster(OUTPUT_DIR);
        const result = await linkWithAliases(data, targets[0], canonical, { known, by: 'admin' });

        if (!result.ok && result.conflict) {
            return `*${canonical}* ya está registrado con otro número. Primero: !roster unlink ${canonical}`;
        }
        if (!result.ok) return 'Uso: !vincula @persona <gamertag>';

        const digits = jidDigits(targets[0]) || '????';
        const extra = known ? '' : ' (sin partidas todavía: rating provisional)';
        const sugerencia = (!known && match.suggestion) ? `\n¿O era *${sanitizeCaptionText(match.suggestion)}*?` : '';
        return `Listo: …${digits} es *${canonical}*${extra}.${sugerencia}`;
    });
}

/** Comando !roster: lista los vínculos; "unlink <tag>" (admin) desvincula. */
async function handleRosterCommand({ args, msg, senderId }) {
    const arg = (args || '').trim();

    if (/^unlink(\s|$)/i.test(arg)) {
        if (!(await isAdminSender(senderId, msg))) return 'Solo un admin puede desvincular.';
        const tag = sanitizeCaptionText(arg.replace(/^unlink\s*/i, '')).trim();
        if (!tag) return 'Uso: !roster unlink <gamertag>';
        return withRosterLock(async () => {
            const data = rosterStore.loadRoster(OUTPUT_DIR);
            if (!rosterStore.unlinkGamertag(data, tag)) return `*${tag}* no está en el roster.`;
            rosterStore.saveRoster(OUTPUT_DIR, data);
            return `*${tag}* fuera del roster.`;
        });
    }

    const data = rosterStore.loadRoster(OUTPUT_DIR);
    if (!data.links.length) return 'Roster vacío. Cada quien: !soy <gamertag>';

    const lines = [`*ROSTER* (${data.links.length} registrado${data.links.length !== 1 ? 's' : ''})`];
    for (const link of [...data.links].sort((a, b) => a.gamertag.localeCompare(b.gamertag))) {
        const phone = link.jids.find(j => j.endsWith('@c.us')) || link.jids[0] || '';
        const digits = jidDigits(phone) || '????';
        lines.push(`• ${link.gamertag} — …${digits}`);
    }
    lines.push('', 'Para registrarte: !soy <gamertag>');
    return lines.join('\n');
}

/**
 * Comando !perdida: da por perdida la partida en curso (walkover / W.O.).
 * El equipo del declarante (o del mencionado) pierde; se registra una partida
 * virtual que cuenta para el marcador de rondas y la cuenta ($), nunca para
 * las stats individuales. Cualquiera de los 4 de la reta en curso puede
 * declararla; deshacer es solo de admin.
 */
const PERDIDA_USAGE = 'Usos:\n• *!perdida* — tu equipo da por perdida la partida en curso\n• *!perdida @persona* — el equipo de esa persona la da por perdida\n• *!perdida deshacer* — borra el último W.O. (solo admin)';

const FORFEIT_COOLDOWN_MS = 5 * 60 * 1000; // dos W.O. de la misma reta en <5 min = doble declaración

async function handlePerdidaCommand({ format, args, msg, mentionedIds, senderId }) {
    if (format !== '2v2') {
        return 'El comando !perdida solo funciona en el grupo de retas 2v2.';
    }

    const own = whatsapp.getOwnIds();
    const allMentions = [...new Set(mentionedIds || [])];
    const humanMentions = allMentions.filter(j => !own.has(j));
    const arg = teams.stripMentionTokens(args).toLowerCase();

    if (arg === 'deshacer') {
        if (!(await isAdminSender(senderId, msg))) return 'Solo un admin puede deshacer un W.O.';
        return withForfeitLock(async () => {
            const data = forfeits.loadForfeits(OUTPUT_DIR);
            if (!data.forfeits.length) return 'No hay W.O. que borrar.';
            const removed = data.forfeits.pop();
            forfeits.saveForfeits(OUTPUT_DIR, data);
            const who = [...removed.sides[removed.loserSide]].sort().map(sanitizeCaptionText).join(' + ');
            const update = formatLiveRoundUpdate(currentOrLastSession(await getRondasGames()));
            return [`W.O. de ${who} borrado.`, update].filter(Boolean).join('\n');
        });
    }
    if (humanMentions.length > 1) return 'Menciona solo a una persona: !perdida @persona';
    // Mencionar solo al bot, o texto que no es "deshacer": mostrar el uso
    if (!humanMentions.length && (arg || allMentions.length)) return PERDIDA_USAGE;

    // ¿Quién la da por perdida? El mencionado, o el que manda el comando.
    // En ambos casos el DECLARANTE debe ser de la reta en curso (o admin).
    const senderTag = await resolveSenderTag(senderId);
    let target;
    if (humanMentions.length === 1) {
        const { tags, unresolvedDisplays } = await resolveMentionsToTags(humanMentions);
        if (unresolvedDisplays.length) {
            return `Sin registrar: ${unresolvedDisplays.join(', ')}. Que mande *!soy <gamertag>* primero.`;
        }
        target = tags[0];
    } else {
        target = senderTag;
        if (!target) return 'No sé quién eres. Manda *!soy <gamertag>* o usa: !perdida @persona';
    }

    // Validar y registrar DENTRO del candado: un "deshacer" u otro W.O.
    // concurrente puede cambiar la sesión entre la validación y la escritura.
    return withForfeitLock(async () => {
        const games = await getRondasGames();
        const session = currentOrLastSession(games);
        if (!session || !session.live || !session.games.length) {
            return 'No hay reta en curso que dar por perdida.';
        }
        const { sides } = lineupOf(session.games[session.games.length - 1]);
        if (sides.length !== 2) return 'No hay reta en curso que dar por perdida.';

        const sideName = side => [...side].sort((a, b) => a.localeCompare(b)).map(sanitizeCaptionText).join(' + ');

        const senderInReta = senderTag && forfeits.sideIndexOf(sides, senderTag) !== -1;
        if (!senderInReta && !(await isAdminSender(senderId, msg))) {
            return `Solo los 4 de la reta en curso pueden declarar un W.O. (${sideName(sides[0])} 🆚 ${sideName(sides[1])}).`;
        }

        const loserSide = forfeits.sideIndexOf(sides, target);
        if (loserSide === -1) {
            return `*${sanitizeCaptionText(target)}* no está en la reta en curso (${sideName(sides[0])} 🆚 ${sideName(sides[1])}).`;
        }

        // Anti doble-declaración: si ya hay un W.O. de esta misma reta hace
        // menos de 5 min (dos personas reaccionando al mismo crash), no se apila.
        const data = forfeits.loadForfeits(OUTPUT_DIR);
        const last = data.forfeits[data.forfeits.length - 1];
        if (last && Date.now() - Date.parse(last.timestamp) < FORFEIT_COOLDOWN_MS
            && forfeits.lineupKeyOf(last.sides) === forfeits.lineupKeyOf(sides)) {
            return 'Ese W.O. ya quedó registrado hace un momento. Si perdieron OTRA partida más, repite el comando en unos minutos.';
        }

        data.forfeits.push({
            timestamp: new Date().toISOString(),
            sides,
            loserSide,
            declaredBy: senderId || null,
        });
        forfeits.saveForfeits(OUTPUT_DIR, data);
        const update = formatLiveRoundUpdate(currentOrLastSession(await getRondasGames()));
        return [`W.O. de ${sideName(sides[loserSide])}.`, update].filter(Boolean).join('\n');
    });
}

/**
 * Comando !anular: anula POR COMPLETO la última partida registrada (se inició
 * por error y aun así el cliente la reportó). A diferencia de !perdida (que
 * agrega un W.O. de una reta legítima) y de !rondas reset (que solo corta el
 * marcador visible), esto marca la partida como is_voided en la base y deja
 * de contar para TODO: marcador, cuenta ($), corte semanal y stats. Pueden
 * anular los que la jugaron (o un admin); deshacer es solo de admin.
 */
const ANULAR_USAGE = 'Usos:\n• *!anular* — anula la última partida registrada (se jugó por error): deja de contar para marcador, cuenta y stats\n• *!anular deshacer* — restaura la última partida anulada con este comando (solo admin)\nPara borrar un W.O. usa *!perdida deshacer*.';

async function handleAnularCommand({ format, args, msg, mentionedIds, senderId }) {
    const arg = teams.stripMentionTokens(args).toLowerCase();

    if (arg === 'deshacer') {
        if (!(await isAdminSender(senderId, msg))) return 'Solo un admin puede deshacer una anulación.';
        return withAnularLock(async () => {
            const data = anuladas.loadAnuladas(OUTPUT_DIR);
            if (!data.anuladas.length) return 'No hay partidas anuladas con este comando que restaurar.';
            const removed = data.anuladas.pop();
            await supabase.setVoided(removed.gameId, false);
            anuladas.saveAnuladas(OUTPUT_DIR, data);
            return `Partida restaurada: *${sanitizeCaptionText(removed.mapName || '?')}* (${removed.gameId.slice(0, 8)}). Vuelve a contar para todo.`;
        });
    }
    if (arg || (mentionedIds || []).length) return ANULAR_USAGE;

    const [isAdmin, senderTag] = await Promise.all([
        isAdminSender(senderId, msg),
        resolveSenderTag(senderId),
    ]);

    // Validar y anular DENTRO del candado: dos !anular casi simultáneos no
    // deben tumbar dos partidas (la segunda sería una partida real).
    return withAnularLock(async () => {
        const [game] = await supabase.getRecentGamesWithPlayers(1, format);
        const data = anuladas.loadAnuladas(OUTPUT_DIR);
        const last = data.anuladas[data.anuladas.length - 1];
        const check = anuladas.validateAnulacion({
            game, senderTag, isAdmin,
            lastAnnulledAt: last ? last.annulledAt : null,
            gapMinutes: SESSION_GAP_MINUTES,
        });
        if (!check.ok) return check.error;

        await supabase.setVoided(game.game_unique_id, true, `comando !anular por ${senderTag || senderId || 'desconocido'}`);
        data.anuladas.push({
            gameId: game.game_unique_id,
            mapName: game.map_name,
            gameTimestamp: game.timestamp,
            annulledAt: new Date().toISOString(),
            by: senderId || null,
        });
        anuladas.saveAnuladas(OUTPUT_DIR, data);
        console.log(`🚫 [WHATSAPP] Partida anulada con !anular: ${game.game_unique_id} (por ${senderTag || senderId || '?'})`);

        const quienes = [...new Set((game.players || []).map(p => sanitizeCaptionText(p.gamertag)))].join(', ');
        return `*Partida anulada:* ${sanitizeCaptionText(game.map_name || '?')} (${game.game_unique_id.slice(0, 8)})${quienes ? ` — ${quienes}` : ''}.\nYa no cuenta para marcador, cuenta ni stats.`;
    });
}

/**
 * Mapas sin identificar: códigos crudos vistos que aún no tienen nombre.
 * Para recopilarlos y luego mapearlos. GET /api/admin/unknown-maps
 */
app.get('/api/admin/unknown-maps', adminAuthMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabase.client
            .from('games')
            .select('map_code, timestamp')
            .not('map_code', 'is', null);
        if (error) throw error;

        const known = new Set(Object.keys(MAP_NAMES));
        const counts = {};
        for (const g of data || []) {
            if (known.has(g.map_code)) continue;
            if (!counts[g.map_code]) counts[g.map_code] = { code: g.map_code, count: 0, lastSeen: g.timestamp };
            counts[g.map_code].count++;
            if (g.timestamp > counts[g.map_code].lastSeen) counts[g.map_code].lastSeen = g.timestamp;
        }
        res.json(Object.values(counts).sort((a, b) => b.count - a.count));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Backfill: aplica un nombre a todas las partidas con un map_code dado.
 * Se usa tras agregar el código a utils/maps.js (para corregir partidas viejas).
 * POST /api/admin/map-backfill  Body: { code, name }
 */
app.post('/api/admin/map-backfill', adminAuthMiddleware, async (req, res) => {
    try {
        const code = String(req.body?.code || '').trim().toLowerCase();
        const name = String(req.body?.name || '').trim();
        if (!code || !name) return res.status(400).json({ error: 'Faltan code y/o name' });

        const { data, error } = await supabase.client
            .from('games')
            .update({ map_name: name })
            .eq('map_code', code)
            .select('game_unique_id');
        if (error) throw error;
        res.json({ status: 'ok', code, name, updated: (data || []).length });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============== DASHBOARD STATS ENDPOINTS ==============

// Formato pedido en el query (?format=2v2|4v4), default 2v2.
function reqFormat(req) {
    return FORMATS.includes(req.query.format) ? req.query.format : '2v2';
}

/**
 * Global Stats por formato
 */
app.get('/api/stats/global', async (req, res) => {
    try {
        const games = await supabase.getAllValidGamesWithPlayers(reqFormat(req));
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
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * MVP & Top Performers por formato
 */
app.get('/api/stats/mvp', async (req, res) => {
    try {
        const MIN_GAMES = parseInt(process.env.LEADERBOARD_MIN_GAMES || '5', 10);

        const games = await supabase.getAllValidGamesWithPlayers(reqFormat(req));
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

        // Agregar jugadores y récord V-D-E desde las partidas del formato pedido
        const allGames = await supabase.getAllValidGamesWithPlayers(reqFormat(req));
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
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/api/stats/recent', async (req, res) => {
    try {
        const gamesWithPlayers = await supabase.getRecentGamesWithPlayers(10, reqFormat(req));
        res.json(gamesWithPlayers);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Lista simple de jugadores del formato (para buscadores/selectores del dashboard)
 */
app.get('/api/stats/players', async (req, res) => {
    try {
        const games = await supabase.getAllValidGamesWithPlayers(reqFormat(req));
        const players = aggregatePlayers(games)
            .map(p => ({ gamertag: p.gamertag, total_games: p.total_games }))
            .sort((a, b) => a.gamertag.localeCompare(b.gamertag));
        res.json(players);
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
        const games = await supabase.getAllValidGamesWithPlayers(reqFormat(req));
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
        const games = await supabase.getAllValidGamesWithPlayers(reqFormat(req));
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

    // Comando del grupo: !partidas -> últimas 10 partidas del formato del grupo
    // (Retas H3 -> 2v2, Torneos Halo 3 -> 4v4).
    whatsapp.registerCommand('!partidas', async ({ format }) => {
        const games = await supabase.getRecentGamesWithPlayers(10, format);
        return formatRecentGamesWhatsApp(games);
    });

    // Comando del grupo: !caracola -> equipos parejos por skill. Acepta
    // menciones (@persona, resueltas vía roster), gamertags escritos, o mezcla,
    // y responde mencionando a los jugadores. !equipos queda como alias.
    whatsapp.registerCommand('!caracola', handleEquiposCommand);
    whatsapp.registerCommand('!equipos', handleEquiposCommand);

    // Roster número ↔ gamertag: autoregistro, vínculo por admin y listado
    whatsapp.registerCommand('!soy', handleSoyCommand);
    whatsapp.registerCommand('!vincula', handleVinculaCommand);
    whatsapp.registerCommand('!roster', handleRosterCommand);

    // Comando del grupo: !perdida -> walkover de la partida en curso.
    // Cuenta para rondas y cuenta ($), nunca para stats. Solo 2v2.
    whatsapp.registerCommand('!perdida', handlePerdidaCommand);

    // Comando del grupo: !anular -> anula la última partida (se jugó por
    // error): is_voided en la base, deja de contar para marcador y stats.
    whatsapp.registerCommand('!anular', handleAnularCommand);

    // Comando del grupo: !rondas -> marcador de la sesión en rondas ($25/ronda),
    // con la ronda en curso en vivo. EXCLUSIVO del grupo 2v2 (así se apuesta).
    whatsapp.registerCommand('!rondas', async ({ format, args }) => {
        if (format !== '2v2') {
            // OJO: la respuesta no puede EMPEZAR con "!rondas" — el bot procesa
            // sus propios mensajes (message_create) y se dispararía en bucle.
            return 'El comando !rondas solo funciona en el grupo de retas 2v2.';
        }
        const arg = (args || '').trim().toLowerCase();
        if (arg === 'reset') {
            setResetTs(OUTPUT_DIR);
            return '*Marcador en ceros.* Rondas y cuenta arrancan desde ahora.\nLas partidas anteriores siguen en las stats, y las deudas de la semana siguen vivas: el corte del lunes las cobra igual.';
        }
        if (arg) {
            return 'Usos:\n• *!rondas* — marcador de la sesión (rondas Bo3 y cuenta)\n• *!rondas reset* — reinicia marcador y cuenta desde este momento';
        }
        const games = await getRondasGames();
        return formatRondasMessage(currentOrLastSession(games));
    });

    // Tareas programadas de los lunes (solo grupo 2v2 / Retas H3):
    // 09:00 corte de saldos + reset del marcador, 10:00 "¿Habrá revancha?"
    startSchedules(whatsapp, { sendWeeklySaldos });
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
