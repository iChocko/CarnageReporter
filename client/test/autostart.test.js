/**
 * Tests del modo automático del cliente (v1.6.0): contenido del .vbs de
 * arranque invisible, preferencias en settings.json y comparación de
 * versiones del auto-update.
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    buildVbsContent, isNewerVersion, loadSettings, saveSettings, VERSION
} = require('../carnage_client');
const { migrateLegacyFile } = require('../src/paths');
const { VBS_FILE } = require('../src/autostart');
const { SETTINGS_FILE } = require('../src/settings');

console.log('\n— buildVbsContent (.vbs de arranque invisible) —');

test('exe empaquetado: comillas VBS escapadas y flag --background', () => {
    const vbs = buildVbsContent('C:\\Juegos\\Carnage Reporter\\CarnageReporter.exe');
    // La ruta con espacios queda entre comillas escapadas ("" dentro del string VBS)
    assert.ok(vbs.includes('""C:\\Juegos\\Carnage Reporter\\CarnageReporter.exe"" --background'));
    // Ventana oculta (0) y sin esperar (False)
    assert.ok(vbs.includes(', 0, False'));
    assert.ok(vbs.startsWith('CreateObject("WScript.Shell").Run "'));
});

test('modo desarrollo: node + script, ambos entre comillas', () => {
    const vbs = buildVbsContent('C:\\nodejs\\node.exe', 'C:\\repo\\client\\carnage_client.js');
    assert.ok(vbs.includes('""C:\\nodejs\\node.exe"" ""C:\\repo\\client\\carnage_client.js"" --background'));
});

console.log('\n— settings.json (preferencia de autoarranque) —');

test('sin archivo o corrupto -> objeto vacío, sin tronar', () => {
    const missing = path.join(os.tmpdir(), `no_existe_${Date.now()}.json`);
    assert.deepStrictEqual(loadSettings(missing), {});

    const corrupt = path.join(os.tmpdir(), `corrupto_${Date.now()}.json`);
    fs.writeFileSync(corrupt, '{esto no es json');
    assert.deepStrictEqual(loadSettings(corrupt), {});
    fs.unlinkSync(corrupt);
});

test('round-trip: guardar hace merge sin perder llaves previas', () => {
    const file = path.join(os.tmpdir(), `settings_${Date.now()}.json`);
    saveSettings({ autostart: 'no' }, file);
    assert.strictEqual(loadSettings(file).autostart, 'no');

    // Un guardado posterior con otra llave no borra la anterior
    saveSettings({ otraCosa: 42 }, file);
    const merged = loadSettings(file);
    assert.strictEqual(merged.autostart, 'no');
    assert.strictEqual(merged.otraCosa, 42);

    // Y cambiar la preferencia sí la sobreescribe
    saveSettings({ autostart: 'on' }, file);
    assert.strictEqual(loadSettings(file).autostart, 'on');
    fs.unlinkSync(file);
});

console.log('\n— isNewerVersion (auto-update) —');

test('detecta versiones nuevas con y sin prefijo v', () => {
    assert.strictEqual(isNewerVersion('v1.6.0', '1.5.0'), true);
    assert.strictEqual(isNewerVersion('1.6.1', '1.6.0'), true);
    assert.strictEqual(isNewerVersion('v2.0.0', '1.9.9'), true);
});

test('no se "actualiza" a la misma versión ni a una vieja', () => {
    assert.strictEqual(isNewerVersion('v1.6.0', '1.6.0'), false);
    assert.strictEqual(isNewerVersion('1.5.0', '1.6.0'), false);
});

test('la VERSION del cliente coincide con client/package.json', () => {
    const { version } = require('../package.json');
    assert.strictEqual(VERSION, version);
});

console.log('\n— DATA_DIR: settings.js y autostart.js apuntan ahí, no a BASE_DIR —');

test('SETTINGS_FILE y VBS_FILE viven en DATA_DIR (paths.js), no junto al exe', () => {
    const { DATA_DIR } = require('../src/paths');
    assert.strictEqual(path.dirname(SETTINGS_FILE), DATA_DIR);
    assert.strictEqual(path.dirname(VBS_FILE), DATA_DIR);
});

console.log('\n— migrateLegacyFile (Fase B3: settings.json / .vbs legados) —');

function makeDirs() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-base-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-data-'));
    return { baseDir, dataDir };
}

test('copia el archivo legado de BASE_DIR a DATA_DIR sin borrar el original', () => {
    const { baseDir, dataDir } = makeDirs();
    fs.writeFileSync(path.join(baseDir, 'settings.json'), '{"autostart":"on"}');

    const migrated = migrateLegacyFile('settings.json', baseDir, dataDir);

    assert.strictEqual(migrated, true);
    assert.ok(fs.existsSync(path.join(baseDir, 'settings.json')), 'el archivo viejo debe seguir ahí');
    assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')), 'debe existir la copia nueva');
    assert.strictEqual(
        fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf-8'),
        fs.readFileSync(path.join(baseDir, 'settings.json'), 'utf-8')
    );
});

test('no hace nada si ya existe una copia en DATA_DIR (no la pisa)', () => {
    const { baseDir, dataDir } = makeDirs();
    fs.writeFileSync(path.join(baseDir, 'settings.json'), '{"autostart":"on"}');
    fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"autostart":"no","installId":"ya-tenia"}');

    const migrated = migrateLegacyFile('settings.json', baseDir, dataDir);

    assert.strictEqual(migrated, false);
    assert.ok(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf-8').includes('ya-tenia'));
});

test('no hace nada si no había archivo legado que migrar', () => {
    const { baseDir, dataDir } = makeDirs();
    assert.strictEqual(migrateLegacyFile('settings.json', baseDir, dataDir), false);
    assert.ok(!fs.existsSync(path.join(dataDir, 'settings.json')));
});

test('carnage_autostart.vbs también se migra (copia): el Run key viejo sigue apuntando al original', () => {
    const { baseDir, dataDir } = makeDirs();
    const vbsContent = buildVbsContent('C:\\vieja\\ruta.exe');
    fs.writeFileSync(path.join(baseDir, 'carnage_autostart.vbs'), vbsContent);

    const migrated = migrateLegacyFile('carnage_autostart.vbs', baseDir, dataDir);

    assert.strictEqual(migrated, true);
    // El .vbs original (al que ya apunta el Run key de una instalación vieja)
    // sigue intacto: la migración es una copia, no un movimiento.
    assert.strictEqual(fs.readFileSync(path.join(baseDir, 'carnage_autostart.vbs'), 'utf-8'), vbsContent);
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'carnage_autostart.vbs'), 'utf-8'), vbsContent);
});

test('si BASE_DIR y DATA_DIR son la misma carpeta (sin LOCALAPPDATA), no hay nada que migrar', () => {
    const { baseDir } = makeDirs();
    fs.writeFileSync(path.join(baseDir, 'settings.json'), '{}');
    assert.strictEqual(migrateLegacyFile('settings.json', baseDir, baseDir), false);
});

