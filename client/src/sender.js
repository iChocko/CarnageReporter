'use strict';

// ============== ENVÍO AL SERVIDOR ==============
// Node 22 trae fetch y AbortSignal.timeout de forma nativa: ya no hace falta
// axios ni el módulo http/https crudo que usaba el monolito.

const SUCCESS_STATUSES = ['processed', 'duplicate', 'voided', 'skipped'];

/**
 * Envía una partida al servidor y clasifica la respuesta para que quien
 * llama decida si reintentar:
 *  - 'done'         : 200 con un status de éxito conocido.
 *  - 'retry'        : sin conexión, timeout, 429, 5xx, o 200 con status "error".
 *  - 'reject'       : 400, o 200 con un cuerpo que no reconocemos.
 *  - 'unauthorized' : 401/403 (API key inválida).
 *  - 'revoked'      : 403 con body.status === 'revoked' (esta instalación puntual).
 *  - 'upgrade'      : 426 con body.status === 'upgrade_required'.
 *
 * `config` puede traer `installId` y `gamertag` (identidad de la
 * instalación, Fase B3): se mandan como X-Install-Id/X-Gamertag-Hint además
 * del campo installId en el cuerpo.
 */
async function sendReport(config, gameData, players, filename, version, timeoutMs = 30000) {
    const payload = JSON.stringify({
        schemaVersion: 3,
        clientVersion: version,
        installId: config.installId || null,
        clientSentAt: new Date().toISOString(),
        gameData,
        players,
        filename
    });

    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
        'X-Install-Id': config.installId || '',
        'User-Agent': `CarnageReporter/${version}`
    };
    if (config.gamertag) headers['X-Gamertag-Hint'] = config.gamertag;

    let res;
    try {
        res = await fetch(`${config.serverUrl}/api/report`, {
            method: 'POST',
            headers,
            body: payload,
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch {
        // Sin conexión, DNS caído, o el AbortSignal disparó por timeout
        return { kind: 'retry', status: null, body: null };
    }

    const text = await res.text().catch(() => '');
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = null;
    }

    if (res.status === 403 && body && body.status === 'revoked') {
        return { kind: 'revoked', status: res.status, body };
    }
    if (res.status === 401 || res.status === 403) {
        return { kind: 'unauthorized', status: res.status, body };
    }
    if (res.status === 426 && body && body.status === 'upgrade_required') {
        return { kind: 'upgrade', status: res.status, body };
    }
    if (res.status === 429) {
        const retryAfterHeader = res.headers.get('retry-after');
        const parsed = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
        return {
            kind: 'retry', status: res.status, body,
            retryAfterSeconds: Number.isFinite(parsed) ? parsed : null
        };
    }
    if (res.status >= 500) {
        return { kind: 'retry', status: res.status, body };
    }
    if (res.status === 400) {
        return { kind: 'reject', status: res.status, body };
    }
    if (res.status === 200) {
        if (body && body.status === 'error') {
            return { kind: 'retry', status: res.status, body };
        }
        if (body && SUCCESS_STATUSES.includes(body.status)) {
            return { kind: 'done', status: res.status, body };
        }
        // 200 con un cuerpo inesperado o no-JSON: no vale la pena reintentar
        // (el servidor ya respondió OK), pero tampoco es un éxito reconocible.
        return { kind: 'reject', status: res.status, body };
    }

    return { kind: 'reject', status: res.status, body };
}

async function verifyServerConnection(config) {
    console.log(`\nServidor: ${config.serverUrl.replace(/^https?:\/\//, '')}`);
    try {
        await fetch(`${config.serverUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
        console.log('✅ Conexión con el servidor establecida.');
        return true;
    } catch {
        console.log('⚠️  Servidor fuera de línea. Se intentará reconectar al jugar.');
        return false;
    }
}

module.exports = { sendReport, verifyServerConnection, SUCCESS_STATUSES };
