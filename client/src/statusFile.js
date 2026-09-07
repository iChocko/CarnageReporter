'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDataDir } = require('./paths');
const spool = require('./spool');

// ============== status.json (Fase B4) ==============
// Snapshot en disco del estado del proceso de fondo: --status lo lee sin
// tener que despertar/consultar la instancia corriendo (y sirve de
// respaldo si el servidor de status en 127.0.0.1:47613 no contesta).

function statusFilePath(dataDir = DATA_DIR) {
    return path.join(dataDir, 'status.json');
}

function buildStatus(state, dataDir = DATA_DIR) {
    let pending = 0;
    try { pending = spool.listPending(dataDir).length; } catch { pending = 0; }
    const failed = spool.countFailed(dataDir);

    return {
        pid: process.pid,
        version: state.version,
        mode: state.mode,
        startedAt: state.startedAt,
        lastReportAt: state.lastReportAt,
        reportsSent: state.reportsSent,
        pending,
        failed,
        lastError: state.lastError,
        serverReachable: state.serverReachable,
        lastUpdateCheck: state.lastUpdateCheck,
    };
}

function writeStatus(state, dataDir = DATA_DIR) {
    try {
        ensureDataDir(dataDir);
        fs.writeFileSync(statusFilePath(dataDir), JSON.stringify(buildStatus(state, dataDir), null, 2));
    } catch { /* status.json es un extra informativo, nunca debe tronar el cliente */ }
}

function readStatus(dataDir = DATA_DIR) {
    try {
        return JSON.parse(fs.readFileSync(statusFilePath(dataDir), 'utf-8'));
    } catch {
        return null;
    }
}

module.exports = { buildStatus, writeStatus, readStatus, statusFilePath };
