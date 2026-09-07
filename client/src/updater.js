'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { BASE_DIR, DATA_DIR, ensureDataDir, IS_BACKGROUND } = require('./paths');
const { buildVbsContent, VBS_FILE } = require('./autostart');
const { loadSettings, saveSettings } = require('./settings');
const { RELEASE_PUBLIC_KEY_PEM } = require('./releaseKey');

// ============== SISTEMA DE AUTO-ACTUALIZACIÓN (Fase B5) ==============
// Desde v1.7 toda actualización se verifica antes de aplicarse: hash SHA256
// contra dist/SHA256SUMS del release + firma Ed25519 de ese archivo contra
// la clave pública embebida (releaseKey.js). Si el release no publica esos
// dos archivos (releases viejos, anteriores a esta fase) NO se actualiza:
// nunca se cae a instalar un .exe sin verificar. Ver docs/release-signing.md.

const GITHUB_REPO = 'iChocko/CarnageReporter';

const UPDATES_DIR = path.join(DATA_DIR, 'updates');
const PREV_EXE = path.join(BASE_DIR, 'CarnageReporter.prev.exe');
const UPDATE_LOG = path.join(DATA_DIR, 'update.log');
const UPDATE_STATE_FILE = path.join(DATA_DIR, 'update-state.json');
const UPDATER_BAT = path.join(DATA_DIR, 'updater.bat');

// Cuántas veces (x1s) el .bat espera a que el proceso actual termine antes
// de mover archivos de todas formas. Es una red de seguridad, no debería
// hacer falta: el propio proceso ya llamó a process.exit() antes de spawnear
// el .bat.
const MAX_WAIT_TRIES = 30;

// Comparación simple de versiones semver (major.minor.patch)
function isNewerVersion(latest, current) {
    const latestParts = latest.replace('v', '').split('.').map(Number);
    const currentParts = current.replace('v', '').split('.').map(Number);

    for (let i = 0; i < 3; i++) {
        const l = latestParts[i] || 0;
        const c = currentParts[i] || 0;
        if (l > c) return true;
        if (l < c) return false;
    }
    return false;
}

// Elige un asset del release por nombre EXACTO (mayúsculas/minúsculas
// aparte): desde B5 el updater ya no adivina "el primer .exe", pide los tres
// archivos por su nombre publicado en CI (CarnageReporter.exe, SHA256SUMS,
// SHA256SUMS.sig).
function pickAsset(assets, exactName) {
    const target = String(exactName).toLowerCase();
    return (assets || []).find(a => a && String(a.name || '').toLowerCase() === target) || null;
}

// Parsea el formato de `sha256sum` (dos formatos válidos: "<hash>  nombre" o
// "<hash> *nombre" en modo binario) en un Map nombre -> hash (minúsculas).
function parseSha256Sums(text) {
    const map = new Map();
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
        if (!match) continue;
        map.set(match[2].trim(), match[1].toLowerCase());
    }
    return map;
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifySha256(filePath, expectedHash) {
    if (!expectedHash) return false;
    try {
        return sha256File(filePath) === String(expectedHash).toLowerCase();
    } catch {
        return false;
    }
}

// Verifica la firma Ed25519 sobre los bytes EXACTOS de SHA256SUMS (los
// mismos que firmó client/scripts/sign-release.js en CI).
function verifySignature(data, signatureBase64, publicKeyPem = RELEASE_PUBLIC_KEY_PEM) {
    try {
        const publicKey = crypto.createPublicKey(publicKeyPem);
        const signature = Buffer.from(String(signatureBase64).trim(), 'base64');
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        return crypto.verify(null, buf, publicKey, signature);
    } catch {
        return false;
    }
}

function safeUnlink(filePath) {
    try { fs.unlinkSync(filePath); } catch { /* no había nada que borrar, o ya se movió */ }
}

async function fetchBuffer(url, version) {
    const res = await fetch(url, {
        headers: { 'User-Agent': `CarnageReporter/${version}` },
        signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) throw new Error(`Descarga falló (${res.status}): ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

// ============== GENERACIÓN DEL .bat DE INTERCAMBIO ==============
// El propio proceso Node ya se cerró (process.exit) antes de que este .bat
// arranque; el "wait for PID" es una red de seguridad extra por si el
// exit tarda o algo más sigue teniendo el .exe abierto (ej. un antivirus).

function escapeForBatEcho(str) {
    return String(str).replace(/[%^&<>|]/g, '^$&');
}

function buildRelaunchCommand(currentExe) {
    if (IS_BACKGROUND) {
        try { fs.writeFileSync(VBS_FILE, buildVbsContent(currentExe)); } catch { /* si falla, cae al start "" normal */ }
        return `start "" wscript.exe "${VBS_FILE}"`;
    }
    return `start "" "${currentExe}"`;
}

function buildSwapBatScript({ pid, moves, postMoveLines = [], relaunch, logFile, selfPath }) {
    const moveLines = moves
        .map(({ from, to }) => `move /y "${from}" "${to}" >> "${logFile}" 2>&1`)
        .join('\r\n');

    return `@echo off
setlocal
set "LOGFILE=${logFile}"
echo [%date% %time%] Iniciando actualizacion (PID ${pid})... >> "%LOGFILE%"
set tries=0
:waitloop
tasklist /FI "PID eq ${pid}" 2>NUL | find "${pid}" >NUL
if errorlevel 1 goto proceed
set /a tries+=1
if %tries% GEQ ${MAX_WAIT_TRIES} goto proceed
timeout /t 1 /nobreak > nul
goto waitloop
:proceed
echo [%date% %time%] Aplicando cambios de archivos... >> "%LOGFILE%"
${moveLines}
${postMoveLines.join('\r\n')}
echo [%date% %time%] Relanzando... >> "%LOGFILE%"
${relaunch}
del /f /q "${selfPath}"
`;
}

// Actualización normal: exe actual -> CarnageReporter.prev.exe (respaldo
// para --rollback), exe nuevo (ya verificado) -> exe actual.
function buildUpdateBatContent({ pid, currentExe, newExe, prevExe, fromVersion, toVersion, relaunch, logFile, batPath, stateFile }) {
    const stateJson = JSON.stringify({ from: fromVersion, to: toVersion, at: new Date().toISOString() });
    const postMoveLines = [
        `> "${stateFile}" echo ${escapeForBatEcho(stateJson)}`,
        `echo [%date% %time%] Actualizacion completa: v${fromVersion} -^> v${toVersion} >> "${logFile}"`
    ];
    return buildSwapBatScript({
        pid, relaunch, logFile,
        moves: [
            { from: currentExe, to: prevExe },
            { from: newExe, to: currentExe }
        ],
        postMoveLines,
        selfPath: batPath
    });
}

// Rollback: intercambia exe actual <-> CarnageReporter.prev.exe (usa un
// archivo temporal para el intercambio de 3 pasos). Deja el update-state.json
// borrado: ya no hay "actualización reciente" que ofrecer revertir, aunque
// --rollback sigue funcionando (el prev.exe quedó con lo que era el actual).
function buildRollbackBatContent({ pid, currentExe, prevExe, relaunch, logFile, batPath, stateFile }) {
    const tempFile = `${currentExe}.rollback_tmp`;
    const postMoveLines = [
        `if exist "${stateFile}" del /f /q "${stateFile}"`,
        `echo [%date% %time%] Rollback completo >> "${logFile}"`
    ];
    return buildSwapBatScript({
        pid, relaunch, logFile,
        moves: [
            { from: currentExe, to: tempFile },
            { from: prevExe, to: currentExe },
            { from: tempFile, to: prevExe }
        ],
        postMoveLines,
        selfPath: batPath
    });
}

function spawnBat(batPath) {
    spawn('cmd.exe', ['/c', batPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: IS_BACKGROUND,
        cwd: BASE_DIR
    }).unref();
}

function readUpdateState() {
    try {
        return JSON.parse(fs.readFileSync(UPDATE_STATE_FILE, 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * Revierte a la versión anterior (CarnageReporter.prev.exe), si existe.
 * Igual que una actualización normal: genera el .bat, lo lanza y cierra
 * este proceso para que el .bat pueda reemplazar el .exe en uso.
 */
function rollbackUpdate() {
    if (!fs.existsSync(PREV_EXE)) {
        console.log('⚠️  No hay una versión anterior guardada para revertir (no existe CarnageReporter.prev.exe).');
        return false;
    }

    ensureDataDir(DATA_DIR);
    const currentExe = process.execPath;
    const relaunch = buildRelaunchCommand(currentExe);
    const batContent = buildRollbackBatContent({
        pid: process.pid,
        currentExe,
        prevExe: PREV_EXE,
        relaunch,
        logFile: UPDATE_LOG,
        batPath: UPDATER_BAT,
        stateFile: UPDATE_STATE_FILE
    });
    fs.writeFileSync(UPDATER_BAT, batContent);
    spawnBat(UPDATER_BAT);

    console.log('↩️  Revirtiendo a la versión anterior. La aplicación se reiniciará en unos segundos...');
    process.exit(0);
    return true; // inalcanzable, pero mantiene una forma de función normal
}

function applySwapAndRelaunch({ newExe, fromVersion, toVersion }) {
    ensureDataDir(DATA_DIR);
    const currentExe = process.execPath;
    const relaunch = buildRelaunchCommand(currentExe);
    const batContent = buildUpdateBatContent({
        pid: process.pid,
        currentExe,
        newExe,
        prevExe: PREV_EXE,
        fromVersion,
        toVersion,
        relaunch,
        logFile: UPDATE_LOG,
        batPath: UPDATER_BAT,
        stateFile: UPDATE_STATE_FILE
    });
    fs.writeFileSync(UPDATER_BAT, batContent);
    spawnBat(UPDATER_BAT);
    process.exit(0);
}

/**
 * Descarga el .exe del release + SHA256SUMS + SHA256SUMS.sig, verifica todo
 * (tamaño anunciado, hash SHA256, firma Ed25519) y solo si TODO pasa aplica
 * el reemplazo. Cualquier fallo de verificación cancela la actualización sin
 * tocar el ejecutable en uso.
 */
async function downloadAndApplyUpdate({ version, latestVersion, exeAsset, sumsAsset, sigAsset }) {
    ensureDataDir(UPDATES_DIR);
    const versionTag = latestVersion.replace(/^v/, '');
    const partPath = path.join(UPDATES_DIR, `${versionTag}.exe.part`);
    const finalPath = path.join(UPDATES_DIR, `${versionTag}.exe`);

    try {
        console.log('📥 Descargando actualización...');
        const exeBuf = await fetchBuffer(exeAsset.browser_download_url, version);
        if (typeof exeAsset.size === 'number' && exeBuf.length !== exeAsset.size) {
            console.log('⚠️  El tamaño descargado no coincide con el anunciado por GitHub. Actualización cancelada.');
            return false;
        }
        fs.writeFileSync(partPath, exeBuf);

        console.log('🔐 Verificando integridad y firma...');
        const sumsBuf = await fetchBuffer(sumsAsset.browser_download_url, version);
        const sigBuf = await fetchBuffer(sigAsset.browser_download_url, version);

        if (!verifySignature(sumsBuf, sigBuf.toString('utf-8'))) {
            console.log('⚠️  La firma de SHA256SUMS no es válida. Actualización cancelada por seguridad.');
            safeUnlink(partPath);
            return false;
        }

        const sumsMap = parseSha256Sums(sumsBuf.toString('utf-8'));
        const expectedHash = sumsMap.get('CarnageReporter.exe');
        if (!verifySha256(partPath, expectedHash)) {
            console.log('⚠️  El hash SHA256 no coincide (descarga corrupta o manipulada). Actualización cancelada.');
            safeUnlink(partPath);
            return false;
        }

        fs.renameSync(partPath, finalPath);
        console.log('✅ Descarga verificada. Aplicando actualización...');
        applySwapAndRelaunch({ newExe: finalPath, fromVersion: version, toVersion: versionTag });
        return true; // inalcanzable en la práctica (applySwapAndRelaunch llama a process.exit)
    } catch (err) {
        console.log('⚠️  Falló la descarga/verificación de la actualización.');
        console.debug(err && err.message);
        safeUnlink(partPath);
        return false;
    }
}

async function checkForUpdates(version) {
    if (process.env.SKIP_UPDATE) return;

    const settings = loadSettings();
    const now = Date.now();
    if (settings.updateRateLimitReset && now < settings.updateRateLimitReset) {
        console.log(`⏳ Límite de peticiones a GitHub alcanzado; se reintentará después de ${new Date(settings.updateRateLimitReset).toLocaleString()}.`);
        return;
    }

    try {
        console.log('🔍 Buscando actualizaciones...');
        const headers = {
            'User-Agent': `CarnageReporter/${version}`,
            'Accept': 'application/vnd.github.v3+json'
        };
        if (settings.updateEtag) headers['If-None-Match'] = settings.updateEtag;

        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
            headers,
            signal: AbortSignal.timeout(8000)
        });

        const etag = res.headers && typeof res.headers.get === 'function' ? res.headers.get('etag') : null;
        if (etag) saveSettings({ updateEtag: etag });

        if (res.status === 304) {
            console.log('✅ Estás usando la versión más reciente (sin cambios desde la última revisión).');
            saveSettings({ lastUpdateCheck: Date.now() });
            return;
        }

        if (res.status === 403) {
            const remaining = res.headers && res.headers.get ? res.headers.get('x-ratelimit-remaining') : null;
            if (remaining === '0') {
                const resetHeader = res.headers.get('x-ratelimit-reset');
                const resetMs = resetHeader ? Number(resetHeader) * 1000 : now + 60 * 60 * 1000;
                saveSettings({ updateRateLimitReset: resetMs });
                console.log(`⏳ Límite de peticiones a GitHub alcanzado; se reintentará después de ${new Date(resetMs).toLocaleString()}.`);
                return;
            }
        }

        if (res.status === 404) {
            console.log('⚠️  No hay releases publicados aún.');
            return;
        }
        if (!res.ok) {
            console.log('⚠️  No se pudo verificar actualizaciones.');
            return;
        }

        // Petición exitosa: ya no estamos limitados por rate-limit.
        saveSettings({ lastUpdateCheck: Date.now(), updateRateLimitReset: undefined });

        const data = await res.json();
        const latestVersion = data.tag_name;

        if (!isNewerVersion(latestVersion, version)) {
            console.log('✅ Estás usando la versión más reciente.');
            return;
        }

        console.log(`\n✨ ¡Nueva versión disponible: ${latestVersion}! (Actual: v${version})`);

        const exeAsset = pickAsset(data.assets, 'CarnageReporter.exe');
        const sumsAsset = pickAsset(data.assets, 'SHA256SUMS');
        const sigAsset = pickAsset(data.assets, 'SHA256SUMS.sig');

        if (!exeAsset) {
            console.log('⚠️  No se encontró CarnageReporter.exe en el release.');
            return;
        }
        if (!sumsAsset || !sigAsset) {
            console.log('⚠️  Este release no publica SHA256SUMS/SHA256SUMS.sig: no se puede verificar su integridad. Actualización cancelada por seguridad.');
            return;
        }

        await downloadAndApplyUpdate({ version, latestVersion, exeAsset, sumsAsset, sigAsset });
    } catch (err) {
        // No bloquear el inicio si falla la verificación
        console.log('⚠️  No se pudo verificar actualizaciones.');
        console.debug(err && err.message);
    }
}

module.exports = {
    isNewerVersion, pickAsset, checkForUpdates, GITHUB_REPO,
    parseSha256Sums, sha256File, verifySha256, verifySignature,
    buildSwapBatScript, buildUpdateBatContent, buildRollbackBatContent,
    rollbackUpdate, readUpdateState,
    UPDATES_DIR, PREV_EXE, UPDATE_LOG, UPDATE_STATE_FILE, UPDATER_BAT, MAX_WAIT_TRIES
};
