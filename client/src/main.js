'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { VERSION } = require('./version');
const paths = require('./paths');
const autostart = require('./autostart');
const { queryRunningInstance } = require('./statusServer');
const { parseXML } = require('./parser');

function parseArgs(argv) {
    return {
        background: argv.includes('--background'),
        status: argv.includes('--status'),
        version: argv.includes('--version'),
        selftest: argv.includes('--selftest'),
        enableAutostart: argv.includes('--enable-autostart'),
        disableAutostart: argv.includes('--disable-autostart'),
    };
}

// Empaqueta el flujo real del parser (lectura de disco incluida) contra el
// fixture de pruebas, para poder verificar un .exe recién compilado en CI
// sin necesitar un XML real de una partida.
function runSelftest() {
    const fixture = path.join(__dirname, '..', 'test', 'fixtures', 'mpcarnagereport_2v2.xml');
    let tmpDir;
    try {
        const xml = fs.readFileSync(fixture, 'utf-8');
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-selftest-'));
        const tmpFile = path.join(tmpDir, 'mpcarnagereport_selftest.xml');
        fs.writeFileSync(tmpFile, xml);

        const { gameData, players } = parseXML(tmpFile);

        if (!gameData || !gameData.gameUniqueId || gameData.gameUniqueId === 'unknown'
            || !Array.isArray(players) || players.length === 0) {
            console.error('Selftest: el parser no devolvió datos válidos.');
            return 1;
        }

        console.log(`Selftest OK: ${players.length} jugadores, mapa ${gameData.mapName}.`);
        return 0;
    } catch (err) {
        console.error('Selftest falló:', err.message);
        return 1;
    } finally {
        try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* limpieza best-effort */ }
    }
}

async function main(entryScript, argv = process.argv.slice(2)) {
    const flags = parseArgs(argv);

    if (flags.version) {
        console.log(VERSION);
        return 0;
    }

    if (flags.selftest) {
        return runSelftest();
    }

    if (flags.enableAutostart) {
        const ok = autostart.enableAutostart(paths.IS_PKG ? null : entryScript);
        console.log(ok ? 'Arranque automático activado.' : 'No se pudo activar el arranque automático.');
        return ok ? 0 : 1;
    }

    if (flags.disableAutostart) {
        const ok = autostart.disableAutostart();
        console.log(ok ? 'Arranque automático desactivado.' : 'No se pudo desactivar el arranque automático.');
        return ok ? 0 : 1;
    }

    if (flags.status) {
        const inst = await queryRunningInstance();
        if (!inst) {
            console.log('No hay ninguna instancia corriendo.');
            return 1;
        }
        console.log(JSON.stringify(inst, null, 2));
        return 0;
    }

    if (flags.background) {
        await require('./ui/background').runBackground(VERSION);
    } else {
        await require('./ui/interactive').runInteractive(entryScript, VERSION);
    }
    return 0;
}

module.exports = { main, parseArgs, runSelftest };
