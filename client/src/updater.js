'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BASE_DIR, IS_BACKGROUND } = require('./paths');
const { buildVbsContent, VBS_FILE } = require('./autostart');

// ============== SISTEMA DE AUTO-ACTUALIZACIÓN ==============

const GITHUB_REPO = 'iChocko/CarnageReporter';

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

function pickAsset(assets) {
    return (assets || []).find(a => a.name.toLowerCase().endsWith('.exe')) || null;
}

async function checkForUpdates(version) {
    if (process.env.SKIP_UPDATE) return;

    try {
        console.log('🔍 Buscando actualizaciones...');
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
            headers: {
                'User-Agent': `CarnageReporter/${version}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            signal: AbortSignal.timeout(8000)
        });

        if (res.status === 404) {
            console.log('⚠️  No hay releases publicados aún.');
            return;
        }
        if (!res.ok) {
            console.log('⚠️  No se pudo verificar actualizaciones.');
            return;
        }

        const data = await res.json();
        const latestVersion = data.tag_name;

        if (isNewerVersion(latestVersion, version)) {
            console.log(`\n✨ ¡Nueva versión disponible: ${latestVersion}! (Actual: v${version})`);

            const asset = pickAsset(data.assets);
            if (!asset) {
                console.log('⚠️  No se encontró el archivo ejecutable en el release.');
                return;
            }

            console.log('📥 Descargando actualización...');
            const downloadRes = await fetch(asset.browser_download_url, {
                headers: { 'User-Agent': `CarnageReporter/${version}` },
                signal: AbortSignal.timeout(60000) // 1 minuto para descargas grandes
            });
            if (!downloadRes.ok) {
                console.log('⚠️  No se pudo descargar la actualización.');
                return;
            }

            // Siempre junto al exe: en modo automático el cwd es System32
            const tempExe = path.join(BASE_DIR, 'update_temp.exe');
            const buf = Buffer.from(await downloadRes.arrayBuffer());
            fs.writeFileSync(tempExe, buf);

            console.log('✅ Descarga completa. Reiniciando para aplicar cambios...');

            // Crear script de reemplazo (.bat para Windows)
            const currentExe = process.execPath;
            const batPath = path.join(BASE_DIR, 'updater.bat');

            // En segundo plano el relanzamiento debe ser invisible (via el
            // .vbs de autoarranque); en manual se reabre la consola normal.
            let relaunch = `start "" "${currentExe}"`;
            if (IS_BACKGROUND) {
                try { fs.writeFileSync(VBS_FILE, buildVbsContent(currentExe)); } catch { /* si falla, el relanzamiento cae al start "" normal */ }
                relaunch = `start "" wscript.exe "${VBS_FILE}"`;
            }

            // Usar rutas absolutas y escapar correctamente
            const batContent = `@echo off
echo Aplicando actualizacion...
timeout /t 2 /nobreak > nul
del /f /q "${currentExe}"
if exist "${currentExe}" (
    timeout /t 2 /nobreak > nul
    del /f /q "${currentExe}"
)
move /y "${tempExe}" "${currentExe}"
${relaunch}
del /f /q "%~f0"
`;

            fs.writeFileSync(batPath, batContent);

            // Lanzar el bat y cerrar la app
            spawn('cmd.exe', ['/c', batPath], {
                detached: true,
                stdio: 'ignore',
                windowsHide: IS_BACKGROUND,
                cwd: BASE_DIR
            }).unref();

            process.exit(0);
        } else {
            console.log('✅ Estás usando la versión más reciente.');
        }
    } catch {
        // No bloquear el inicio si falla la verificación
        console.log('⚠️  No se pudo verificar actualizaciones.');
    }
}

module.exports = { isNewerVersion, pickAsset, checkForUpdates, GITHUB_REPO };
