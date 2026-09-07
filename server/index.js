/**
 * CarnageReporter Server
 * Servidor centralizado para procesar reportes de Halo 3 MCC
 *
 * Fase A2: este archivo es solo el bootstrap. La lógica vive repartida en
 * server/{config,app,http,report,domain,commands,jobs,state}: dotenv ->
 * config -> logger -> servicios + ctx -> createApp(ctx) -> listen ->
 * whatsapp.initialize -> registerAll -> startSchedules -> lifecycle
 * (shutdown / manejadores de proceso).
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');

const { logger } = require('./logger');
const alerts = require('./alerts');
const { loadConfig } = require('./config');
const { createServices } = require('./services');
const { buildCtx } = require('./context');
const { createApp } = require('./app');
const { createLifecycle } = require('./lifecycle');
const { sendWeeklySaldos } = require('./domain/saldos');
const { registerAll } = require('./commands');
const { startSchedules } = require('./jobs/scheduler');
const { runBackup } = require('./jobs/backup');
const { runCleanup } = require('./jobs/cleanup');
const { version: SERVER_VERSION } = require('./package.json');

const log = logger.child({ mod: 'http' });

let config;
try {
    config = loadConfig();
} catch (err) {
    log.error(`❌ ${err.message}`);
    process.exit(1);
}

// Directorio de output para PNGs temporales
const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const services = createServices(config);
const { whatsapp, supabase } = services;

// Referencia a las tareas cron (server/jobs/scheduler.js), asignada en
// start(): para reportarlas en /api/health y detenerlas en el apagado limpio.
let schedulerHandle = null;

const ctx = buildCtx({
    config,
    logger,
    services,
    alerts,
    outputDir: OUTPUT_DIR,
    version: SERVER_VERSION,
    getSchedulerJobs: () => (schedulerHandle?.tasks || []).map(({ name, task }) => ({ name, status: task.getStatus() })),
});

const app = createApp(ctx);

let httpServer = null; // instancia de http.Server (app.listen), para el apagado limpio

async function start() {
    log.info('╔══════════════════════════════════════════════════════════╗');
    log.info('║              CARNAGE REPORTER SERVER                     ║');
    log.info('║           Halo 3 MCC Stats - VPS Edition                 ║');
    log.info('╚══════════════════════════════════════════════════════════╝');

    // Iniciar servidor Express
    httpServer = app.listen(config.PORT, '0.0.0.0', () => {
        log.info(`🚀 Servidor escuchando en http://0.0.0.0:${config.PORT}`);
        log.info('   POST /api/report - Recibir reportes');
        log.info('   GET  /api/health - Health check');
        log.info('   GET  /api/status - Estado del servidor');
        log.info('👀 Esperando reportes de clientes...');
    });

    // Avisos operativos de WhatsApp (sesión caída/recuperada) por el canal de
    // alertas (server/alerts.js), no el Discord de resultados. whatsapp.js ya
    // arma el texto con su propio prefijo (🔴/🟢); aquí se deriva el nivel y
    // se le quita para que alerts.alert() ponga el suyo (evita duplicarlo).
    // Sin cooldown: whatsapp.js ya deduplica por episodio (sessionLostAlerted).
    whatsapp.setAlertHandler(text => {
        const level = text.startsWith('🔴') ? 'error' : text.startsWith('🟢') ? 'info' : 'warn';
        const clean = text.replace(/^[🔴🟠🟢]\s*/u, '');
        return alerts.alert(level, clean, { key: `whatsapp:session:${level}`, cooldownMs: 0 });
    });

    // Inicializar WhatsApp en segundo plano (no bloquea el arranque de Express)
    whatsapp.initialize().catch(err => {
        log.error({ err }, '❌ WhatsApp no pudo inicializar');
    });

    // Comandos del grupo de WhatsApp (server/commands/index.js)
    registerAll(whatsapp, ctx);

    // Tareas programadas (server/jobs/scheduler.js): corte semanal de saldos,
    // mensaje de los lunes, backup y limpieza diarios. La referencia se
    // guarda para /api/health y para detenerlas en el apagado (lifecycle.js).
    schedulerHandle = startSchedules(whatsapp, {
        sendWeeklySaldos: (opts) => sendWeeklySaldos(ctx, opts),
        runBackup: () => runBackup({
            outputDir: OUTPUT_DIR,
            authDir: whatsapp.authPath,
            supabase,
            includeAuthDir: config.BACKUP_INCLUDE_AUTH,
        }),
        runCleanup: () => runCleanup({ outputDir: OUTPUT_DIR }),
    });

    return httpServer;
}

const lifecycle = createLifecycle({
    whatsapp,
    alerts,
    getHttpServer: () => httpServer,
    getSchedulerHandle: () => schedulerHandle,
});
lifecycle.registerProcessHandlers();

start().catch(err => {
    log.fatal({ err }, '💀 start() falló, el servidor no pudo arrancar');
    process.exit(1);
});
