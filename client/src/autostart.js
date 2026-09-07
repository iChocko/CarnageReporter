'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { IS_PKG, BASE_DIR } = require('./paths');

// ============== ARRANQUE AUTOMÁTICO CON WINDOWS ==============
// La clave Run de HKCU (no pide admin) apunta a wscript + un .vbs de una
// línea que lanza el exe SIN ventana. Apuntar la clave directo al exe
// mostraría un consolazo negro en cada arranque de Windows.

const VBS_FILE = path.join(BASE_DIR, 'carnage_autostart.vbs');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'CarnageReporter';

function buildVbsContent(exePath, scriptPath = null) {
    // En desarrollo el "exe" es node y hay que pasarle el script; empaquetado
    // el exe se basta solo. Las comillas dobles ("") escapan en VBS.
    const cmd = scriptPath
        ? `""${exePath}"" ""${scriptPath}"" --background`
        : `""${exePath}"" --background`;
    return `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`;
}

/**
 * @param {string|null} scriptPath ruta del script de entrada en modo
 *   desarrollo (ignorada si estamos empaquetados: el propio exe se basta).
 */
function enableAutostart(scriptPath = null) {
    if (process.platform !== 'win32') return false;
    try {
        fs.writeFileSync(VBS_FILE, buildVbsContent(process.execPath, IS_PKG ? null : scriptPath));
    } catch {
        return false;
    }
    const r = spawnSync('reg', [
        'add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ',
        '/d', `wscript.exe "${VBS_FILE}"`, '/f'
    ], { windowsHide: true });
    return r.status === 0;
}

function disableAutostart() {
    if (process.platform !== 'win32') return false;
    const r = spawnSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true });
    try { fs.unlinkSync(VBS_FILE); } catch { /* no había .vbs que borrar */ }
    return r.status === 0;
}

/**
 * @param {string|null} scriptPath ruta del script de entrada en modo
 *   desarrollo (ignorada si estamos empaquetados).
 */
function launchBackgroundInstance(scriptPath = null) {
    // Con pkg, execPath ES el exe; en desarrollo es node y hay que pasar el script
    const args = IS_PKG ? ['--background'] : [scriptPath, '--background'];
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: BASE_DIR }).unref();
}

module.exports = {
    buildVbsContent, enableAutostart, disableAutostart, launchBackgroundInstance,
    VBS_FILE, RUN_KEY, RUN_VALUE
};
