/**
 * Tests de jobs/backup.js: empaquetado local (.tar.gz de output/*.json +
 * authDir), poda de backups viejos y la segunda copia en Supabase (con un
 * fake que no toca la red).
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const { runBackup, backupFileName, BACKUP_SUBDIR } = require('../jobs/backup');

function makeTree() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
    const outputDir = path.join(base, 'output');
    const authDir = path.join(base, '.wwebjs_auth');
    fs.mkdirSync(outputDir, { recursive: true });
    return { base, outputDir, authDir };
}

function fakeSupabase(impl) {
    const calls = [];
    return {
        calls,
        saveStateBackup: async (name, takenAt, content) => {
            calls.push({ name, takenAt, content });
            return impl ? impl(name, takenAt, content) : true;
        },
    };
}

test('backupFileName: formato state-YYYYMMDD-HHmm.tar.gz', () => {
    const ts = new Date('2026-01-05T09:07:00').getTime();
    assert.strictEqual(backupFileName(ts), 'state-20260105-0907.tar.gz');
});

test('runBackup: empaqueta output/*.json + authDir, y sube cada JSON a Supabase', async () => {
    const { outputDir, authDir } = makeTree();
    fs.mkdirSync(path.join(authDir, 'session'), { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'whatsapp_roster.json'), JSON.stringify({ links: [] }));
    fs.writeFileSync(path.join(outputDir, 'forfeits.json'), JSON.stringify({ forfeits: [] }));
    fs.writeFileSync(path.join(authDir, 'session', 'creds.json'), '{}');
    // Un PNG de partida no debe colarse en el backup de estado.
    fs.writeFileSync(path.join(outputDir, 'match_abc.png'), Buffer.from([0]));

    const supabase = fakeSupabase();
    const now = Date.parse('2026-03-10T08:00:00Z');
    const result = await runBackup({ outputDir, authDir, supabase, now });

    assert.strictEqual(result.jsonFiles, 2);
    assert.strictEqual(result.uploaded, 2);
    assert.strictEqual(result.pruned, 0);
    assert.ok(fs.existsSync(result.archivePath));
    assert.strictEqual(path.dirname(result.archivePath), path.join(outputDir, BACKUP_SUBDIR));

    const namesUploaded = supabase.calls.map(c => c.name).sort();
    assert.deepStrictEqual(namesUploaded, ['forfeits.json', 'whatsapp_roster.json']);
    assert.deepStrictEqual(supabase.calls[0].content, JSON.parse(fs.readFileSync(path.join(outputDir, `${supabase.calls[0].name}`), 'utf-8')));

    // El .tar.gz debe contener los JSON y el directorio de sesión, no el PNG.
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-extract-'));
    await tar.extract({ file: result.archivePath, cwd: extractDir });
    const extractedOutput = fs.readdirSync(path.join(extractDir, 'output')).sort();
    assert.deepStrictEqual(extractedOutput, ['forfeits.json', 'whatsapp_roster.json']);
    assert.ok(fs.existsSync(path.join(extractDir, '.wwebjs_auth', 'session', 'creds.json')));
});

test('runBackup: sin JSON ni authDir -> no truena, archivePath null', async () => {
    const { outputDir, authDir } = makeTree(); // authDir no existe
    const supabase = fakeSupabase();
    const result = await runBackup({ outputDir, authDir, supabase, now: Date.now() });
    assert.strictEqual(result.archivePath, null);
    assert.strictEqual(result.jsonFiles, 0);
    assert.strictEqual(result.uploaded, 0);
});

test('runBackup: un error de Supabase en un archivo no tumba el backup de los demás', async () => {
    const { outputDir, authDir } = makeTree();
    fs.writeFileSync(path.join(outputDir, 'a.json'), JSON.stringify({ ok: 1 }));
    fs.writeFileSync(path.join(outputDir, 'b.json'), JSON.stringify({ ok: 2 }));

    const supabase = fakeSupabase((name) => {
        if (name === 'a.json') throw new Error('boom');
        return true;
    });
    const result = await runBackup({ outputDir, authDir, supabase, now: Date.now() });

    assert.strictEqual(result.jsonFiles, 2);
    assert.strictEqual(result.uploaded, 1); // solo b.json contó como subido
    assert.ok(fs.existsSync(result.archivePath)); // el backup local no se vio afectado
});

test('runBackup: supabase.client null (saveStateBackup regresa false) -> sigue sin tronar', async () => {
    const { outputDir, authDir } = makeTree();
    fs.writeFileSync(path.join(outputDir, 'a.json'), JSON.stringify({ ok: 1 }));
    const supabase = fakeSupabase(() => false);
    const result = await runBackup({ outputDir, authDir, supabase, now: Date.now() });
    assert.strictEqual(result.uploaded, 0);
    assert.ok(fs.existsSync(result.archivePath));
});

test('runBackup: poda archivos locales más viejos que keepDays', async () => {
    const { outputDir, authDir } = makeTree();
    fs.writeFileSync(path.join(outputDir, 'a.json'), JSON.stringify({ ok: 1 }));
    const backupDir = path.join(outputDir, BACKUP_SUBDIR);
    fs.mkdirSync(backupDir, { recursive: true });

    const now = Date.parse('2026-06-15T03:30:00Z');
    const oldFile = path.join(backupDir, 'state-20260101-0330.tar.gz');
    const recentFile = path.join(backupDir, 'state-20260614-0330.tar.gz');
    fs.writeFileSync(oldFile, 'x');
    fs.writeFileSync(recentFile, 'x');
    const oldMs = now - 30 * 24 * 60 * 60 * 1000;
    const recentMs = now - 1 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, oldMs / 1000, oldMs / 1000);
    fs.utimesSync(recentFile, recentMs / 1000, recentMs / 1000);

    const supabase = fakeSupabase();
    const result = await runBackup({ outputDir, authDir, supabase, keepDays: 14, now });

    assert.strictEqual(result.pruned, 1);
    assert.ok(!fs.existsSync(oldFile));
    assert.ok(fs.existsSync(recentFile));
});
