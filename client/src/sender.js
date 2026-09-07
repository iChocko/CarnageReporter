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
 *  - 'unauthorized' : 401/403 (API key inválida o revocada).
 */
async function sendReport(config, gameData, players, filename, version, timeoutMs = 30000) {
    const payload = JSON.stringify({
        schemaVersion: 2,
        clientVersion: version,
        gameData,
        players,
        filename
    });

    let res;
    try {
        res = await fetch(`${config.serverUrl}/api/report`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': config.apiKey
            },
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

    if (res.status === 401 || res.status === 403) {
        return { kind: 'unauthorized', status: res.status, body };
    }
    if (res.status === 429 || res.status >= 500) {
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
    } catch {
        console.log('⚠️  Servidor fuera de línea. Se intentará reconectar al jugar.');
    }
}

module.exports = { sendReport, verifyServerConnection, SUCCESS_STATUSES };
