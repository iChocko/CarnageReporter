/**
 * Tests de client/src/updater.js: comparación de versiones y selección del
 * asset .exe del release de GitHub.
 *
 * CARNAGE_DATA_DIR se sobreescribe ANTES de requerir cualquier módulo del
 * cliente: settings.js y updater.js calculan sus rutas (SETTINGS_FILE,
 * UPDATES_DIR, ...) una sola vez al cargarse, así que hay que apuntarlas a
 * un directorio temporal antes de ese require para no tocar el
 * %LOCALAPPDATA%\CarnageReporter real de quien corre las pruebas.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.CARNAGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-updater-test-'));

const { test } = require('node:test');
const assert = require('assert');

const { isNewerVersion, pickAsset, checkForUpdates, UPDATES_DIR } = require('../src/updater');
const { loadSettings, saveSettings, SETTINGS_FILE } = require('../src/settings');

function fakeResponse({ status = 200, headers = {}, jsonBody = null, bufferBody = null }) {
    const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => (headerMap.has(String(name).toLowerCase()) ? headerMap.get(String(name).toLowerCase()) : null) },
        json: async () => jsonBody,
        arrayBuffer: async () => bufferBody || Buffer.alloc(0),
        text: async () => (bufferBody || Buffer.alloc(0)).toString('utf-8')
    };
}

async function withFetch(impl, fn) {
    const originalFetch = global.fetch;
    global.fetch = impl;
    try {
        await fn();
    } finally {
        global.fetch = originalFetch;
    }
}

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

test('elige el asset por nombre EXACTO (sin importar mayúsculas)', () => {
    const assets = [
        { name: 'README.md' },
        { name: 'CarnageReporter.EXE' },
        { name: 'CarnageReporter-Setup.exe' }
    ];
    assert.strictEqual(pickAsset(assets, 'CarnageReporter.exe').name, 'CarnageReporter.EXE');
    assert.strictEqual(pickAsset(assets, 'CarnageReporter-Setup.exe').name, 'CarnageReporter-Setup.exe');
});

test('no confunde nombres parecidos (Setup.exe no es CarnageReporter.exe)', () => {
    const assets = [{ name: 'CarnageReporter-Setup.exe' }];
    assert.strictEqual(pickAsset(assets, 'CarnageReporter.exe'), null);
});

test('sin ese nombre en los assets -> null', () => {
    assert.strictEqual(pickAsset([{ name: 'README.md' }], 'CarnageReporter.exe'), null);
});

test('lista de assets vacía o ausente -> null, no truena', () => {
    assert.strictEqual(pickAsset([], 'CarnageReporter.exe'), null);
    assert.strictEqual(pickAsset(undefined, 'CarnageReporter.exe'), null);
});

console.log('\n— checkForUpdates: ETag/304, rate-limit y rechazo de releases sin verificación —');

test('304 Not Modified: manda If-None-Match, no truena, guarda lastUpdateCheck', async () => {
    saveSettings({ updateEtag: 'W/"abc123"', updateRateLimitReset: undefined });
    let calls = 0;
    await withFetch(async (url, opts) => {
        calls++;
        assert.strictEqual(opts.headers['If-None-Match'], 'W/"abc123"');
        return fakeResponse({ status: 304, headers: { etag: 'W/"abc123"' } });
    }, () => checkForUpdates('1.7.0'));

    assert.strictEqual(calls, 1, 'solo debe consultar releases/latest, nada más');
    assert.ok(loadSettings(SETTINGS_FILE).lastUpdateCheck, 'debe registrar el intento aunque no haya novedades');
});

test('403 + x-ratelimit-remaining=0: guarda updateRateLimitReset a partir del header, no truena', async () => {
    saveSettings({ updateEtag: undefined, updateRateLimitReset: undefined });
    const resetEpochSeconds = Math.floor(Date.now() / 1000) + 1800;
    await withFetch(async () => fakeResponse({
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpochSeconds) }
    }), () => checkForUpdates('1.7.0'));

    assert.strictEqual(loadSettings(SETTINGS_FILE).updateRateLimitReset, resetEpochSeconds * 1000);
});

test('con un updateRateLimitReset futuro ya guardado, ni siquiera hace fetch', async () => {
    saveSettings({ updateRateLimitReset: Date.now() + 3600000 });
    let called = false;
    await withFetch(async () => { called = true; return fakeResponse({ status: 200, jsonBody: {} }); },
        () => checkForUpdates('1.7.0'));

    assert.strictEqual(called, false);
    saveSettings({ updateRateLimitReset: undefined }); // no contaminar las pruebas siguientes
});

test('release sin SHA256SUMS/SHA256SUMS.sig: rechaza la actualización sin intentar descargar el .exe', async () => {
    saveSettings({ updateRateLimitReset: undefined, updateEtag: undefined });
    let fetchCalls = 0;
    await withFetch(async () => {
        fetchCalls++;
        return fakeResponse({
            status: 200,
            jsonBody: {
                tag_name: 'v99.0.0',
                assets: [{ name: 'CarnageReporter.exe', browser_download_url: 'https://example.invalid/exe', size: 10 }]
            }
        });
    }, () => checkForUpdates('1.7.0'));

    assert.strictEqual(fetchCalls, 1, 'no debe pedir ningún asset si faltan los archivos de verificación');
});

test('firma inválida: actualización cancelada, no deja ningún .exe.part en updates/', async () => {
    saveSettings({ updateRateLimitReset: undefined, updateEtag: undefined });
    await withFetch(async (url) => {
        const u = String(url);
        if (u.includes('releases/latest')) {
            return fakeResponse({
                status: 200,
                jsonBody: {
                    tag_name: 'v99.0.1',
                    assets: [
                        { name: 'CarnageReporter.exe', browser_download_url: 'https://example.invalid/exe', size: 4 },
                        { name: 'SHA256SUMS', browser_download_url: 'https://example.invalid/sums' },
                        { name: 'SHA256SUMS.sig', browser_download_url: 'https://example.invalid/sig' }
                    ]
                }
            });
        }
        if (u.includes('/exe')) return fakeResponse({ status: 200, bufferBody: Buffer.from('data') });
        if (u.includes('/sums')) return fakeResponse({ status: 200, bufferBody: Buffer.from(`${'0'.repeat(64)}  CarnageReporter.exe\n`) });
        if (u.includes('/sig')) return fakeResponse({ status: 200, bufferBody: Buffer.from('bm90LXVuYS1maXJtYS12YWxpZGE=') });
        throw new Error(`URL inesperada en el test: ${u}`);
    }, () => checkForUpdates('1.7.0'));

    const leftover = fs.existsSync(UPDATES_DIR) ? fs.readdirSync(UPDATES_DIR) : [];
    assert.deepStrictEqual(leftover, [], 'una firma inválida no debe dejar archivos descargados a medias');
});
