/**
 * /api/health (Fase A1 — observabilidad).
 *
 * Fábrica en vez de un handler fijo: index.js inyecta sus instancias reales
 * de supabase/whatsapp/renderer, y los tests inyectan dobles falsos sin
 * tocar Supabase, WhatsApp ni el disco real (ver server/test/health.test.js).
 *
 * Reglas de negocio:
 *  - 'down' (HTTP 503) SOLO cuando el chequeo de Supabase falla: es la única
 *    dependencia dura del servidor.
 *  - WhatsApp no listo (waiting_qr, disconnected, initializing) es
 *    'degraded' con HTTP 200: el bot puede pasar horas esperando el QR sin
 *    que eso deba reiniciar el contenedor (un healthcheck 503 ahí tumbaría
 *    la sesión a medio pairing).
 *  - El resultado se cachea `cacheMs` (default 10s) para no golpear Supabase
 *    en cada ping del healthcheck de Docker.
 *  - En la TRANSICIÓN a 'down' (no en cada refresco mientras sigue down) se
 *    dispara una alerta (server/alerts.js, key 'health').
 */

'use strict';

const fs = require('fs');

/**
 * @param {object} deps
 * @param {{ client: object|null }} deps.supabase - instancia de SupabaseService (o un fake)
 * @param {{ getStatus: function, enabled: boolean }} deps.whatsapp - instancia de WhatsAppService (o un fake)
 * @param {{ lastOkAt: string|null }} deps.renderer - instancia de RendererService (o un fake)
 * @param {() => Array<{name: string, status: string}>} deps.getSchedulerJobs
 * @param {string} deps.outputDir - directorio para medir espacio libre en disco
 * @param {string} deps.version - versión reportada en el body
 * @param {number} [deps.cacheMs=10000]
 * @param {(level: string, text: string, opts?: object) => Promise<boolean>} [deps.alertFn]
 * @param {() => number} [deps.now=Date.now] - inyectable para tests
 * @param {(path: string) => object} [deps.statfs=fs.statfsSync] - inyectable para tests
 * @returns {{ handler: function, computeHealth: function }}
 */
function createHealthCheck({
    supabase,
    whatsapp,
    renderer,
    getSchedulerJobs,
    outputDir,
    version,
    cacheMs = 10 * 1000,
    alertFn = async () => false,
    now = Date.now,
    statfs = fs.statfsSync,
    // Fase A4 — outbox persistente. `outboxEnabled` viene de config.OUTBOX_ENABLED;
    // `outboxStore` es undefined/null tanto si está apagado como si Supabase
    // no está configurado o la tabla no existe todavía (OutboxUnavailableError).
    outboxEnabled = false,
    outboxStore = null,
}) {
    let cache = null; // { at: number, body: object }
    let lastStatus = null; // para avisar solo en la TRANSICIÓN a 'down'

    /**
     * Chequeo barato de Supabase: SELECT de una sola columna, LIMIT 1, con
     * timeout de 3s. Un timeout no es lo mismo que "caído" pero se reporta
     * igual como fallo (ok:false): el health check no distingue el motivo.
     */
    async function checkSupabase() {
        if (!supabase.client) return { ok: false, ms: null, error: 'Supabase no configurado' };
        const startedAt = now();
        try {
            const query = supabase.client.from('games').select('game_unique_id').limit(1);
            const timeout = new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error('timeout (3s)')), 3000);
            });
            const { error } = await Promise.race([query, timeout]);
            const ms = now() - startedAt;
            if (error) return { ok: false, ms, error: error.message };
            return { ok: true, ms };
        } catch (err) {
            return { ok: false, ms: now() - startedAt, error: err.message };
        }
    }

    /** MB libres en el volumen de outputDir, o null si el runtime/plataforma no lo soporta. */
    function getDiskFreeMb() {
        try {
            const stats = statfs(outputDir);
            return Math.round((stats.bavail * stats.bsize) / (1024 * 1024));
        } catch {
            return null;
        }
    }

    /**
     * Estado del outbox (Fase A4): `pending`/`dead`/`oldestPendingSec` en
     * null cuando está apagado, o cuando `stats()` truena (tabla faltante,
     * Supabase caído) — un fallo aquí no debe tumbar todo el health check.
     */
    async function checkOutbox() {
        if (!outboxEnabled || !outboxStore) {
            return { enabled: outboxEnabled, pending: null, dead: null, oldestPendingSec: null };
        }
        try {
            const stats = await outboxStore.stats();
            return { enabled: true, ...stats };
        } catch (err) {
            return { enabled: true, pending: null, dead: null, oldestPendingSec: null, error: err.message };
        }
    }

    /** Arma { status, checks } sin cachear ni alertar (lo hace el handler). */
    async function computeHealth() {
        const supabaseCheck = await checkSupabase();
        const whatsappState = whatsapp.getStatus().status;
        const outboxCheck = await checkOutbox();

        const checks = {
            supabase: supabaseCheck,
            whatsapp: { enabled: whatsapp.enabled, state: whatsappState, transport: whatsapp.transport || 'wwebjs' },
            renderer: { lastOkAt: renderer.lastOkAt },
            disk: { outputFreeMb: getDiskFreeMb() },
            scheduler: { jobs: getSchedulerJobs() },
            outbox: outboxCheck,
        };

        // Fase A5 — shadow transport (server/messaging/adapters/shadow.js):
        // `whatsapp.shadow` solo existe si WHATSAPP_SHADOW_TRANSPORT está
        // configurado; nunca cuenta para el `status` general (es de solo
        // observación, no debe poder tumbar el health check).
        if (whatsapp.shadow) {
            // El shape de getStatus() del shadow depende de su transporte
            // interno: 'fake' devuelve el shape completo del contrato
            // (`.state`), 'baileys' el shape legado (`.status`) — ver
            // adapters/shadow.js (delega tal cual al puerto envuelto).
            const shadowStatus = whatsapp.shadow.getStatus();
            checks.whatsappShadow = {
                state: shadowStatus.status || shadowStatus.state || 'unknown',
                transport: shadowStatus.transport || null,
            };
        }

        let status = 'ok';
        if (!supabaseCheck.ok) status = 'down';
        else if (whatsapp.enabled && whatsappState !== 'ready') status = 'degraded';
        else if (outboxCheck.dead > 0) status = 'degraded';

        return { status, checks };
    }

    /** Handler de Express: GET /api/health. */
    async function handler(req, res) {
        const nowMs = now();
        if (!cache || nowMs - cache.at > cacheMs) {
            const { status, checks } = await computeHealth();
            if (status === 'down' && lastStatus !== 'down') {
                alertFn('error', `Health check en estado 'down' — Supabase: ${JSON.stringify(checks.supabase)}`, { key: 'health' });
            }
            lastStatus = status;
            cache = {
                at: nowMs,
                body: {
                    status,
                    uptimeSec: Math.round(process.uptime()),
                    version,
                    checks,
                },
            };
        }
        res.status(cache.body.status === 'down' ? 503 : 200).json(cache.body);
    }

    return { handler, computeHealth };
}

module.exports = { createHealthCheck };
