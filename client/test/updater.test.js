/**
 * Tests de client/src/updater.js: comparación de versiones y selección del
 * asset .exe del release de GitHub.
 */

const { test } = require('node:test');
const assert = require('assert');

const { isNewerVersion, pickAsset } = require('../src/updater');

console.log('\n— isNewerVersion —');

test('detecta versiones nuevas con y sin prefijo v', () => {
    assert.strictEqual(isNewerVersion('v1.6.0', '1.5.0'), true);
    assert.strictEqual(isNewerVersion('1.6.1', '1.6.0'), true);
    assert.strictEqual(isNewerVersion('v2.0.0', '1.9.9'), true);
});

test('no se "actualiza" a la misma versión ni a una vieja', () => {
    assert.strictEqual(isNewerVersion('v1.6.0', '1.6.0'), false);
    assert.strictEqual(isNewerVersion('1.5.0', '1.6.0'), false);
});

test('compara correctamente por segmento (minor/patch, no como string)', () => {
    // 1.10.0 > 1.9.0 numéricamente, aunque "10" < "9" como string
    assert.strictEqual(isNewerVersion('1.10.0', '1.9.0'), true);
});

console.log('\n— pickAsset —');

test('elige el primer asset .exe (sin importar mayúsculas)', () => {
    const assets = [
        { name: 'README.md' },
        { name: 'CarnageReporter.EXE' },
        { name: 'CarnageReporter-old.exe' }
    ];
    assert.strictEqual(pickAsset(assets).name, 'CarnageReporter.EXE');
});

test('sin ningún .exe en los assets -> null', () => {
    assert.strictEqual(pickAsset([{ name: 'README.md' }]), null);
});

test('lista de assets vacía o ausente -> null, no truena', () => {
    assert.strictEqual(pickAsset([]), null);
    assert.strictEqual(pickAsset(undefined), null);
});
