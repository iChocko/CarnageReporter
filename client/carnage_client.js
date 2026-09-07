/**
 * Punto de entrada del cliente. La lógica real vive en ./src (ver
 * DEVELOPER_GUIDE.md / docs) — este archivo solo:
 *  - arranca src/main.js cuando se ejecuta como CLI (node/pkg/SEA), y
 *  - re-exporta las funciones que las pruebas siguen importando de aquí
 *    (server/test/maps.test.js y client/test/autostart.test.js).
 */

const mainModule = require('./src/main');
const { VERSION } = require('./src/version');
const { buildVbsContent } = require('./src/autostart');
const { isNewerVersion } = require('./src/updater');
const { loadSettings, saveSettings } = require('./src/settings');
const { extractMapCodeFromFilmName, findMapCodeFromFilms } = require('./src/parser');

if (require.main === module) {
    mainModule.main(__filename).then((code) => {
        if (typeof code === 'number' && code !== 0) process.exitCode = code;
    }).catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
} else {
    module.exports = {
        VERSION,
        buildVbsContent,
        isNewerVersion,
        loadSettings,
        saveSettings,
        extractMapCodeFromFilmName,
        findMapCodeFromFilms
    };
}
