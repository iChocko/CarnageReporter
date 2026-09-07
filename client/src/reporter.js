'use strict';

const { parseXML } = require('./parser');
const { sendReport } = require('./sender');
const spool = require('./spool');
const { STATE } = require('./state');
const { DATA_DIR } = require('./paths');
const { writeStatus } = require('./statusFile');

// ============== DRAIN DEL SPOOL (Fase B3) ==============
// drain() procesa lo pendiente en spool/pending, en orden de llegada
// (firstSeenAt), respetando el backoff de cada archivo (nextAttemptAt). Se
// dispara desde tres lugares: el watcher al detectar un XML nuevo, un timer
// de 60s, y a demanda (--drain-now / POST /drain). single-flight: si ya hay
// un drain en curso, una llamada nueva no hace nada (el timer/watcher ya
// van a volver a intentar).

// Backoff por intento (1-indexed): 5s, 15s, 1m, 5m, 15m, 1h — y se queda en
// 1h (el último valor) para los intentos siguientes hasta el corte de 7 días.
const BACKOFF_MS = [5000, 15000, 60000, 5 * 60000, 15 * 60000, 60 * 60000];
const GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;
const UNAUTHORIZED_RETRY_MS = 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 60;

function backoffFor(attemptNumber) {
    const idx = Math.min(Math.max(attemptNumber - 1, 0), BACKOFF_MS.length - 1);
    return BACKOFF_MS[idx];
}

let draining = false;

/**
 * Procesa un único pendiente. Devuelve true si el drain completo debe
 * detenerse (API key inválida/revocada, o versión de cliente obsoleta):
 * seguir con el resto de pendientes no serviría de nada, todos fallarían
 * por la misma razón.
 */
async function processOne(item, config, version, dataDir, sendReportFn) {
    const { name, xmlPath, meta } = item;

    const ageMs = Date.now() - new Date(meta.firstSeenAt).getTime();
    if (ageMs > GIVE_UP_MS) {
        spool.fail(name, 'gave_up', dataDir);
        console.log(`   🗑️  ${name}: 7 días sin poder enviarse, se archiva como fallido.`);
        return false;
    }

    let parsed;
    try {
        parsed = parseXML(xmlPath);
    } catch (err) {
        spool.fail(name, 'parse_error', dataDir);
        console.error(`   ❌ ${name}: XML corrupto o ilegible (${err.message}), se archiva.`);
        return false;
    }

    const { gameData, players } = parsed;
    const result = await sendReportFn(config, gameData, players, name, version);

    if (result.kind === 'done') {
        spool.complete(name, dataDir);
        if (result.body && result.body.status === 'processed') {
            STATE.reportsSent++;
            STATE.lastReportAt = Date.now();
        }
        return false;
    }

    if (result.kind === 'reject') {
        spool.fail(name, `reject_${result.status ?? 'desconocido'}`, dataDir);
        console.error(`   ❌ ${name}: el servidor rechazó el reporte (${result.status}), se archiva.`);
        return false;
    }

    if (result.kind === 'unauthorized') {
        STATE.lastError = 'API key inválida';
        spool.markAttempt(name, {
            error: 'unauthorized', status: result.status,
            nextAttemptAt: new Date(Date.now() + UNAUTHORIZED_RETRY_MS).toISOString()
        }, dataDir);
        console.error('   🔑 API key inválida: se detiene el envío hasta la próxima hora.');
        return true;
    }

    if (result.kind === 'revoked') {
        STATE.lastError = 'Instalación revocada';
        spool.markAttempt(name, { error: 'revoked', status: result.status }, dataDir);
        console.error('   🚫 Esta instalación fue revocada por el administrador. Contacta soporte.');
        return true;
    }

    if (result.kind === 'upgrade') {
        const minVersion = result.body && result.body.minVersion;
        STATE.lastError = 'Actualiza el cliente';
        spool.markAttempt(name, { error: 'upgrade_required', status: result.status }, dataDir);
        console.error(`   ⬆️  Actualiza el cliente${minVersion ? ` (mínimo v${minVersion})` : ''} para seguir reportando partidas.`);
        return true;
    }

    // 'retry': sin conexión, timeout, 429, 5xx, o 200 con status "error"
    let delayMs;
    if (result.status === 429) {
        const secs = Number.isFinite(result.retryAfterSeconds) ? result.retryAfterSeconds : DEFAULT_RATE_LIMIT_RETRY_SECONDS;
        delayMs = secs * 1000;
    } else {
        delayMs = backoffFor((meta.attempts || 0) + 1);
    }
    const errMsg = (result.body && (result.body.message || result.body.error))
        || (result.status ? `HTTP ${result.status}` : 'sin conexión con el servidor');
    STATE.lastError = errMsg;
    spool.markAttempt(name, {
        error: errMsg, status: result.status,
        nextAttemptAt: new Date(Date.now() + delayMs).toISOString()
    }, dataDir);
    return false;
}

/**
 * Recorre spool/pending en orden de llegada y procesa lo que ya esté listo
 * para reintentarse (nextAttemptAt <= ahora). Single-flight: llamadas
 * concurrentes mientras ya hay un drain corriendo se ignoran.
 */
async function drain({ config, version, dataDir = DATA_DIR, sendReportFn = sendReport } = {}) {
    if (draining) return { drained: 0, skipped: true };
    draining = true;
    let count = 0;
    try {
        const now = Date.now();
        const items = spool.listPending(dataDir).filter(it => new Date(it.meta.nextAttemptAt).getTime() <= now);
        for (const item of items) {
            const stop = await processOne(item, config, version, dataDir, sendReportFn);
            count++;
            if (stop) break;
        }
    } finally {
        draining = false;
    }
    try { writeStatus(STATE, dataDir); } catch { /* status.json es best-effort */ }
    return { drained: count };
}

function isDraining() {
    return draining;
}

module.exports = { drain, isDraining, backoffFor, BACKOFF_MS, GIVE_UP_MS, UNAUTHORIZED_RETRY_MS };
