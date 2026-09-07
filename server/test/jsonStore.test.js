/**
 * Tests de server/state/jsonStore.js: round-trip, fallback tolerante a
 * archivo faltante/corrupto, atomicidad (no debe quedar .tmp huérfano tras
 * un guardado exitoso) y el candado en proceso por archivo.
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readJson, writeJsonAtomic, withFileLock } = require('../state/jsonStore');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'json-store-'));

test('readJson: archivo faltante -> fallback, sin tronar', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'no-existe.json');
    assert.deepStrictEqual(readJson(file, { a: 1 }), { a: 1 });
});

test('readJson: archivo corrupto -> fallback, sin tronar', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'corrupto.json');
    fs.writeFileSync(file, 'esto no es json{');
    assert.strictEqual(readJson(file, null), null);
});

test('writeJsonAtomic + readJson: round-trip exacto', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'datos.json');
    const data = { version: 1, items: [{ a: 'b' }, { c: 2 }] };
    writeJsonAtomic(file, data);
    assert.deepStrictEqual(readJson(file, null), data);
});

test('writeJsonAtomic: no deja .tmp huérfano tras un guardado exitoso', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'datos.json');
    writeJsonAtomic(file, { ok: true });
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('writeJsonAtomic: pretty=true indenta, pretty=false serializa compacto', () => {
    const dir = tmpDir();
    const pretty = path.join(dir, 'pretty.json');
    const compact = path.join(dir, 'compact.json');
    writeJsonAtomic(pretty, { a: 1 });
    writeJsonAtomic(compact, { a: 1 }, { pretty: false });
    assert.ok(fs.readFileSync(pretty, 'utf-8').includes('\n'));
    assert.strictEqual(fs.readFileSync(compact, 'utf-8'), '{"a":1}');
});

test('writeJsonAtomic: si falla el rename, no deja el .tmp huérfano (y re-lanza el error)', () => {
    const dir = tmpDir();
    // "file" es un directorio existente -> renameSync(tmp, file) truena
    // (EISDIR/EPERM) de forma barata y determinista, sin tocar locks reales.
    const file = path.join(dir, 'es-un-directorio.json');
    fs.mkdirSync(file);
    assert.throws(() => writeJsonAtomic(file, { a: 1 }));
    assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('writeJsonAtomic: sobrescribe un archivo existente sin dejar rastro del contenido viejo', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'datos.json');
    writeJsonAtomic(file, { version: 1 });
    writeJsonAtomic(file, { version: 2 });
    assert.deepStrictEqual(readJson(file, null), { version: 2 });
});

test('withFileLock: serializa dos operaciones concurrentes sobre el MISMO archivo', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'contador.json');
    writeJsonAtomic(file, { n: 0 });

    const increment = () => withFileLock(file, async () => {
        const data = readJson(file, { n: 0 });
        // Punto de carrera deliberado: si dos llamadas corrieran en paralelo,
        // ambas leerían el mismo `n` antes de que la otra escriba.
        await new Promise(r => setTimeout(r, 5));
        writeJsonAtomic(file, { n: data.n + 1 });
    });

    await Promise.all([increment(), increment(), increment()]);
    assert.strictEqual(readJson(file, null).n, 3);
});

test('withFileLock: archivos distintos no se bloquean entre sí (corren en paralelo)', async () => {
    const dir = tmpDir();
    const fileA = path.join(dir, 'a.json');
    const fileB = path.join(dir, 'b.json');
    const order = [];

    const slow = withFileLock(fileA, async () => {
        await new Promise(r => setTimeout(r, 20));
        order.push('a');
    });
    const fast = withFileLock(fileB, async () => {
        order.push('b');
    });

    await Promise.all([slow, fast]);
    assert.deepStrictEqual(order, ['b', 'a']); // b (sin espera) termina antes que a
});
