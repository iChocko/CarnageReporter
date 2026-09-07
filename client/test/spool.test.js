/**
 * Tests de client/src/spool.js: intake mueve el XML a spool/pending con su
 * meta, complete/fail lo sacan de ahí, prune limpia lo viejo de failed/, y
 * los nombres colisionados no se pisan entre sí.
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const spool = require('../src/spool');

function tmpDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-spool-test-'));
}

function makeXml(dir, name, content = '<x/>') {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
}

console.log('\n— intake —');

test('mueve el XML a spool/pending y crea su meta', () => {
    const dataDir = tmpDataDir();
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-mcc-'));
    const xmlPath = makeXml(srcDir, 'mpcarnagereport-2026-01-01-00-00-00.xml');

    const name = spool.intake(xmlPath, dataDir);

    assert.strictEqual(name, 'mpcarnagereport-2026-01-01-00-00-00.xml');
    assert.ok(!fs.existsSync(xmlPath), 'el archivo original ya no debe existir en la carpeta de MCC');
    const pending = spool.pendingDir(dataDir);
    assert.ok(fs.existsSync(path.join(pending, name)));
    const meta = JSON.parse(fs.readFileSync(path.join(pending, `${name}.meta.json`), 'utf-8'));
    assert.strictEqual(meta.attempts, 0);
    assert.strictEqual(meta.lastError, null);
    assert.strictEqual(meta.lastStatus, null);
    assert.ok(meta.firstSeenAt);
    assert.ok(meta.nextAttemptAt);
});

test('archivo de origen ya movido (evento duplicado del watcher) -> null, no truena', () => {
    const dataDir = tmpDataDir();
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-mcc-'));
    const xmlPath = path.join(srcDir, 'no_existe.xml');
    assert.strictEqual(spool.intake(xmlPath, dataDir), null);
});

test('nombres colisionados no se pisan: se les agrega sufijo', () => {
    const dataDir = tmpDataDir();
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-mcc-'));

    const first = makeXml(srcDir, 'mpcarnagereport-2026-01-01-00-00-00.xml', 'primero');
    const name1 = spool.intake(first, dataDir);

    const second = makeXml(srcDir, 'mpcarnagereport-2026-01-01-00-00-00.xml', 'segundo');
    const name2 = spool.intake(second, dataDir);

    assert.strictEqual(name1, 'mpcarnagereport-2026-01-01-00-00-00.xml');
    assert.notStrictEqual(name2, name1);
    assert.ok(name2.startsWith('mpcarnagereport-2026-01-01-00-00-00-2'));

    const pending = spool.pendingDir(dataDir);
    assert.strictEqual(fs.readFileSync(path.join(pending, name1), 'utf-8'), 'primero');
    assert.strictEqual(fs.readFileSync(path.join(pending, name2), 'utf-8'), 'segundo');
});

console.log('\n— listPending —');

test('sin carpeta pending todavía -> arreglo vacío, no truena', () => {
    const dataDir = tmpDataDir();
    assert.deepStrictEqual(spool.listPending(dataDir), []);
});

test('ordena por firstSeenAt ascendente (más viejo primero)', () => {
    const dataDir = tmpDataDir();
    const pending = spool.pendingDir(dataDir);
    fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, 'b.xml'), '');
    fs.writeFileSync(path.join(pending, `b.xml.meta.json`), JSON.stringify({
        attempts: 0, firstSeenAt: '2026-01-02T00:00:00.000Z', nextAttemptAt: '2026-01-02T00:00:00.000Z'
    }));
    fs.writeFileSync(path.join(pending, 'a.xml'), '');
    fs.writeFileSync(path.join(pending, `a.xml.meta.json`), JSON.stringify({
        attempts: 0, firstSeenAt: '2026-01-01T00:00:00.000Z', nextAttemptAt: '2026-01-01T00:00:00.000Z'
    }));

    const items = spool.listPending(dataDir);
    assert.deepStrictEqual(items.map(i => i.name), ['a.xml', 'b.xml']);
});

console.log('\n— markAttempt / complete / fail —');

test('markAttempt incrementa attempts y guarda error/status/nextAttemptAt', () => {
    const dataDir = tmpDataDir();
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-mcc-'));
    const xmlPath = makeXml(srcDir, 'g1.xml');
    const name = spool.intake(xmlPath, dataDir);

    const next = new Date(Date.now() + 5000).toISOString();
    const meta = spool.markAttempt(name, { error: 'boom', status: 500, nextAttemptAt: next }, dataDir);

    assert.strictEqual(meta.attempts, 1);
    assert.strictEqual(meta.lastError, 'boom');
    assert.strictEqual(meta.lastStatus, 500);
    assert.strictEqual(meta.nextAttemptAt, next);

    const meta2 = spool.markAttempt(name, { error: 'boom2', status: 500, nextAttemptAt: next }, dataDir);
    assert.strictEqual(meta2.attempts, 2);
});

test('complete borra XML y meta de pending/', () => {
    const dataDir = tmpDataDir();
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-mcc-'));
    const xmlPath = makeXml(srcDir, 'g2.xml');
    const name = spool.intake(xmlPath, dataDir);

    spool.complete(name, dataDir);

    const pending = spool.pendingDir(dataDir);
    assert.ok(!fs.existsSync(path.join(pending, name)));
    assert.ok(!fs.existsSync(path.join(pending, `${name}.meta.json`)));
});

test('complete sobre un nombre inexistente no truena', () => {
    const dataDir = tmpDataDir();
    assert.doesNotThrow(() => spool.complete('no-existe.xml', dataDir));
});

test('fail mueve el XML a spool/failed/ con el motivo en el meta', () => {
    const dataDir = tmpDataDir();
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-mcc-'));
    const xmlPath = makeXml(srcDir, 'g3.xml', 'contenido');
    const name = spool.intake(xmlPath, dataDir);

    spool.fail(name, 'parse_error', dataDir);

    const pending = spool.pendingDir(dataDir);
    const failed = spool.failedDir(dataDir);
    assert.ok(!fs.existsSync(path.join(pending, name)));
    assert.ok(!fs.existsSync(path.join(pending, `${name}.meta.json`)));
    assert.ok(fs.existsSync(path.join(failed, name)));
    assert.strictEqual(fs.readFileSync(path.join(failed, name), 'utf-8'), 'contenido');

    const meta = JSON.parse(fs.readFileSync(path.join(failed, `${name}.meta.json`), 'utf-8'));
    assert.strictEqual(meta.lastError, 'parse_error');
    assert.ok(meta.failedAt);
});

console.log('\n— pruneFailed —');

test('borra de failed/ lo más viejo que maxAgeDays, deja lo reciente', () => {
    const dataDir = tmpDataDir();
    const failed = spool.failedDir(dataDir);
    fs.mkdirSync(failed, { recursive: true });

    fs.writeFileSync(path.join(failed, 'viejo.xml'), '');
    fs.writeFileSync(path.join(failed, 'viejo.xml.meta.json'), JSON.stringify({
        failedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    }));
    fs.writeFileSync(path.join(failed, 'reciente.xml'), '');
    fs.writeFileSync(path.join(failed, 'reciente.xml.meta.json'), JSON.stringify({
        failedAt: new Date().toISOString()
    }));

    const pruned = spool.pruneFailed(30, dataDir);

    assert.strictEqual(pruned, 1);
    assert.ok(!fs.existsSync(path.join(failed, 'viejo.xml')));
    assert.ok(!fs.existsSync(path.join(failed, 'viejo.xml.meta.json')));
    assert.ok(fs.existsSync(path.join(failed, 'reciente.xml')));
});

test('sin carpeta failed todavía -> 0, no truena', () => {
    const dataDir = tmpDataDir();
    assert.strictEqual(spool.pruneFailed(30, dataDir), 0);
});

console.log('\n— countFailed —');

test('cuenta solo los .xml de failed/, no los .meta.json', () => {
    const dataDir = tmpDataDir();
    const failed = spool.failedDir(dataDir);
    fs.mkdirSync(failed, { recursive: true });
    fs.writeFileSync(path.join(failed, 'a.xml'), '');
    fs.writeFileSync(path.join(failed, 'a.xml.meta.json'), '{}');
    fs.writeFileSync(path.join(failed, 'b.xml'), '');
    fs.writeFileSync(path.join(failed, 'b.xml.meta.json'), '{}');

    assert.strictEqual(spool.countFailed(dataDir), 2);
});
