/**
 * Tests de jobs/cleanup.js: borra solo output/match_*.png viejos, nunca los
 * .json de estado ni output/backups/.
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCleanup } = require('../jobs/cleanup');

const tmpOutputDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));

function setMtime(filePath, ts) {
    fs.utimesSync(filePath, ts / 1000, ts / 1000);
}

test('outputDir inexistente -> {deleted: 0}, sin tronar', async () => {
    const result = await runCleanup({ outputDir: path.join(os.tmpdir(), 'no-existe-xyz-123'), now: Date.now() });
    assert.deepStrictEqual(result, { deleted: 0 });
});

test('borra match_*.png más viejos que maxAgeDays, deja los recientes', async () => {
    const outputDir = tmpOutputDir();
    const now = Date.parse('2026-06-15T03:45:00Z');
    const oldPng = path.join(outputDir, 'match_aaaa1111.png');
    const recentPng = path.join(outputDir, 'match_bbbb2222.png');
    fs.writeFileSync(oldPng, Buffer.from([0]));
    fs.writeFileSync(recentPng, Buffer.from([0]));
    setMtime(oldPng, now - 30 * 24 * 60 * 60 * 1000);
    setMtime(recentPng, now - 1 * 24 * 60 * 60 * 1000);

    const result = await runCleanup({ outputDir, maxAgeDays: 14, now });

    assert.strictEqual(result.deleted, 1);
    assert.ok(!fs.existsSync(oldPng));
    assert.ok(fs.existsSync(recentPng));
});

test('nunca borra los .json de estado, aunque sean viejos', async () => {
    const outputDir = tmpOutputDir();
    const now = Date.parse('2026-06-15T03:45:00Z');
    const oldJson = path.join(outputDir, 'whatsapp_roster.json');
    fs.writeFileSync(oldJson, JSON.stringify({ links: [] }));
    setMtime(oldJson, now - 60 * 24 * 60 * 60 * 1000);

    const result = await runCleanup({ outputDir, maxAgeDays: 14, now });

    assert.strictEqual(result.deleted, 0);
    assert.ok(fs.existsSync(oldJson));
});

test('nunca toca output/backups/ (ni el directorio ni su contenido)', async () => {
    const outputDir = tmpOutputDir();
    const now = Date.parse('2026-06-15T03:45:00Z');
    const backupsDir = path.join(outputDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const oldArchive = path.join(backupsDir, 'state-20260101-0330.tar.gz');
    fs.writeFileSync(oldArchive, 'x');
    setMtime(oldArchive, now - 60 * 24 * 60 * 60 * 1000);

    const result = await runCleanup({ outputDir, maxAgeDays: 14, now });

    assert.strictEqual(result.deleted, 0);
    assert.ok(fs.existsSync(oldArchive));
});

test('un nombre que empieza con "match_" pero no termina en .png no se toca', async () => {
    const outputDir = tmpOutputDir();
    const now = Date.parse('2026-06-15T03:45:00Z');
    const other = path.join(outputDir, 'match_aaaa1111.json');
    fs.writeFileSync(other, '{}');
    setMtime(other, now - 60 * 24 * 60 * 60 * 1000);

    const result = await runCleanup({ outputDir, maxAgeDays: 14, now });

    assert.strictEqual(result.deleted, 0);
    assert.ok(fs.existsSync(other));
});
