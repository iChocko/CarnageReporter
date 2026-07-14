/**
 * Tests del modo automático del cliente (v1.6.0): contenido del .vbs de
 * arranque invisible, preferencias en settings.json y comparación de
 * versiones del auto-update.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    buildVbsContent, isNewerVersion, loadSettings, saveSettings, VERSION
} = require('../client/carnage_client');

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
}

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

test('la VERSION del cliente es la 1.6.0 del modo automático', () => {
    assert.strictEqual(VERSION, '1.6.0');
});

console.log(`\n✅ ${passed} tests OK`);
