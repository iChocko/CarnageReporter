'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

// ============== SPOOL DE REPORTES (Fase B3) ==============
// Antes, un XML que fallaba al enviarse se reintentaba desde un setTimeout
// en memoria: si el proceso moría (crash, reinicio de Windows, actualización)
// esa partida se perdía para siempre. Ahora el XML se mueve de la carpeta de
// MCC a DATA_DIR\spool\pending en cuanto se detecta (intake), y desde ahí
// vive en disco hasta que se confirma (complete) o se da por perdido (fail).
// Esto también reemplaza el Set en memoria que usaba el watcher para no
// reprocesar el mismo archivo dos veces: si ya está en pending/, ya se tomó.

function pendingDir(dataDir = DATA_DIR) {
    return path.join(dataDir, 'spool', 'pending');
}

function failedDir(dataDir = DATA_DIR) {
    return path.join(dataDir, 'spool', 'failed');
}

function metaPathFor(dir, name) {
    return path.join(dir, `${name}.meta.json`);
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function readMeta(dir, name, fallback) {
    try {
        return JSON.parse(fs.readFileSync(metaPathFor(dir, name), 'utf-8'));
    } catch {
        return fallback;
    }
}

function writeMeta(dir, name, meta) {
    fs.writeFileSync(metaPathFor(dir, name), JSON.stringify(meta, null, 2));
}

function moveFile(src, dest) {
    try {
        fs.renameSync(src, dest);
    } catch (e) {
        // EXDEV: src/dest en volúmenes distintos (poco probable en Windows,
        // pero DATA_DIR es configurable). Copiar y borrar el original.
        if (e.code === 'EXDEV') {
            fs.copyFileSync(src, dest);
            fs.unlinkSync(src);
        } else {
            throw e;
        }
    }
}

// Nombre único dentro de un directorio: el nombre de archivo de MCC solo
// trae resolución de segundos, así que dos partidas seguidas pueden colisionar.
function uniqueName(dir, filename) {
    if (!fs.existsSync(path.join(dir, filename))) return filename;
    const ext = path.extname(filename);
    const base = filename.slice(0, filename.length - ext.length);
    let n = 2;
    let candidate;
    do {
        candidate = `${base}-${n}${ext}`;
        n++;
    } while (fs.existsSync(path.join(dir, candidate)));
    return candidate;
}

/**
 * Mueve un XML detectado por el watcher a spool/pending/ y crea su meta.
 * @returns {string|null} el nombre asignado en pending/, o null si el
 *   archivo de origen ya no existía (evento duplicado del watcher).
 */
function intake(xmlPath, dataDir = DATA_DIR) {
    if (!fs.existsSync(xmlPath)) return null;
    const dir = pendingDir(dataDir);
    ensureDir(dir);
    const name = uniqueName(dir, path.basename(xmlPath));
    moveFile(xmlPath, path.join(dir, name));
    const now = new Date().toISOString();
    writeMeta(dir, name, { attempts: 0, firstSeenAt: now, nextAttemptAt: now, lastError: null, lastStatus: null });
    return name;
}

/** Lista lo pendiente, ordenado por firstSeenAt ascendente (más viejo primero). */
function listPending(dataDir = DATA_DIR) {
    const dir = pendingDir(dataDir);
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const items = files
        .filter(f => f.endsWith('.xml'))
        .map(name => {
            const now = new Date().toISOString();
            const meta = readMeta(dir, name, { attempts: 0, firstSeenAt: now, nextAttemptAt: now, lastError: null, lastStatus: null });
            return { name, xmlPath: path.join(dir, name), meta };
        });
    items.sort((a, b) => new Date(a.meta.firstSeenAt) - new Date(b.meta.firstSeenAt));
    return items;
}

/** Registra un intento fallido: incrementa attempts y guarda cuándo reintentar. */
function markAttempt(name, { error = null, status = null, nextAttemptAt } = {}, dataDir = DATA_DIR) {
    const dir = pendingDir(dataDir);
    const meta = readMeta(dir, name, { attempts: 0, firstSeenAt: new Date().toISOString() });
    meta.attempts = (meta.attempts || 0) + 1;
    meta.lastError = error;
    meta.lastStatus = status;
    if (nextAttemptAt) meta.nextAttemptAt = nextAttemptAt;
    writeMeta(dir, name, meta);
    return meta;
}

/** Reporte confirmado por el servidor: borra XML + meta de pending/. */
function complete(name, dataDir = DATA_DIR) {
    const dir = pendingDir(dataDir);
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* ya no estaba */ }
    try { fs.unlinkSync(metaPathFor(dir, name)); } catch { /* ya no estaba */ }
}

/** Se da por perdido (payload inválido, parse error, o 7 días sin éxito): a spool/failed/. */
function fail(name, reason, dataDir = DATA_DIR) {
    const pDir = pendingDir(dataDir);
    const fDir = failedDir(dataDir);
    ensureDir(fDir);
    const meta = readMeta(pDir, name, { attempts: 0 });
    meta.lastError = reason;
    meta.failedAt = new Date().toISOString();
    try {
        moveFile(path.join(pDir, name), path.join(fDir, name));
    } catch { /* si el xml ya no está (raro), igual se conserva el meta como evidencia */ }
    writeMeta(fDir, name, meta);
    try { fs.unlinkSync(metaPathFor(pDir, name)); } catch { /* ya no estaba */ }
}

/** Purga de spool/failed/ lo más viejo que maxAgeDays. Devuelve cuántos borró. */
function pruneFailed(maxAgeDays = 30, dataDir = DATA_DIR) {
    const dir = failedDir(dataDir);
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return 0;
    }
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const f of files.filter(x => x.endsWith('.meta.json'))) {
        const name = f.slice(0, -'.meta.json'.length);
        const meta = readMeta(dir, name, {});
        const failedAtMs = meta.failedAt ? new Date(meta.failedAt).getTime() : 0;
        if (failedAtMs && failedAtMs < cutoff) {
            try { fs.unlinkSync(path.join(dir, name)); } catch { /* ya no estaba */ }
            try { fs.unlinkSync(path.join(dir, f)); } catch { /* ya no estaba */ }
            pruned++;
        }
    }
    return pruned;
}

/** Cuenta cuántos XML hay en spool/failed/ (para status.json). */
function countFailed(dataDir = DATA_DIR) {
    try {
        return fs.readdirSync(failedDir(dataDir)).filter(f => f.endsWith('.xml')).length;
    } catch {
        return 0;
    }
}

module.exports = {
    intake, listPending, markAttempt, complete, fail, pruneFailed, countFailed,
    pendingDir, failedDir
};
