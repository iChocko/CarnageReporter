/**
 * CarnageReporter Server
 * Servidor centralizado para procesar reportes de Halo 3 MCC
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

// Servicios
const WhatsAppService = require('./services/whatsapp');
const DiscordService = require('./services/discord');
const SupabaseService = require('./services/supabase');
const RendererService = require('./services/renderer');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'h3mcc-carnage-2024-secret';

// Directorio de output para PNGs temporales
const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Inicializar servicios
const whatsapp = new WhatsAppService();
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
        whatsapp: whatsapp.isReady(),
        version: '1.0.0'
    });
});

/**
 * Estado de WhatsApp
 */
app.get('/api/status', (req, res) => {
    res.json({
        whatsapp: {
            ready: whatsapp.isReady(),
            group: whatsapp.getGroupName()
        },
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
        console.log('🎨 Generando imagen...');
        const pngPath = path.join(OUTPUT_DIR, `match_${gameId}.png`);
        await renderer.generatePNG(gameData, players, pngPath);

        // 3. Enviar a WhatsApp
        console.log('📱 Enviando a WhatsApp...');
        const caption = `🎮 ${gameData.mapName} - ${gameData.gameTypeName}\n📅 ${new Date(gameData.timestamp).toLocaleString()}`;
        await whatsapp.sendImage(pngPath, caption);

        // 4. Enviar a Discord
        console.log('💬 Enviando a Discord...');
        await discord.sendImage(pngPath, gameData, players);

        // 5. Guardar en Supabase
        console.log('💾 Guardando en Supabase...');
        await supabase.saveGame(gameData, players);

        // 6. Limpiar PNG temporal (opcional, mantener para debug)
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
 * Obtener QR de WhatsApp (para configuración inicial)
 */
app.get('/api/whatsapp/qr', (req, res) => {
    const qr = whatsapp.getQR();
    if (qr) {
        res.json({ qr, status: 'pending' });
    } else if (whatsapp.isReady()) {
        res.json({ qr: null, status: 'ready' });
    } else {
        res.json({ qr: null, status: 'initializing' });
    }
});

/**
 * Listar todos los grupos de WhatsApp disponibles
 * GET /api/whatsapp/groups
 */
app.get('/api/whatsapp/groups', authMiddleware, async (req, res) => {
    try {
        const groups = await whatsapp.listGroups();
        res.json({
            currentGroup: whatsapp.getGroupInfo(),
            availableGroups: groups
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Cambiar el grupo de WhatsApp activo
 * POST /api/whatsapp/group
 * Body: { groupId: "xxxxx@g.us" } o { groupName: "Nombre del Grupo" }
 */
app.post('/api/whatsapp/group', authMiddleware, async (req, res) => {
    const { groupId, groupName } = req.body;

    if (!groupId && !groupName) {
        return res.status(400).json({ error: 'Debes proporcionar groupId o groupName' });
    }

    try {
        const result = await whatsapp.setTargetGroup(groupId, groupName);
        if (result.success) {
            res.json({
                status: 'ok',
                message: `Grupo cambiado a: ${result.groupName}`,
                group: result
            });
        } else {
            res.status(404).json({
                status: 'error',
                message: result.message,
                availableGroups: result.availableGroups
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
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

// ============== INICIO DEL SERVIDOR ==============

async function start() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║              CARNAGE REPORTER SERVER                     ║');
    console.log('║           Halo 3 MCC Stats - VPS Edition                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Inicializar WhatsApp
    console.log('📱 Inicializando WhatsApp...');
    await whatsapp.initialize();

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
    await whatsapp.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n\n👋 Cerrando servidor (SIGTERM)...');
    await whatsapp.destroy();
    process.exit(0);
});

start().catch(console.error);
