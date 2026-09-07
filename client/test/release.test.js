/**
 * Tests de la cadena de integridad de releases (Fase B5):
 *  - parseSha256Sums / verifySha256: lectura y verificación de SHA256SUMS.
 *  - verifySignature: firma Ed25519 sobre esos bytes.
 *  - client/scripts/sign-release.js: firma en CI (round-trip con una clave
 *    generada en la propia prueba, nunca con la clave real del proyecto).
 *  - generación de los .bat de actualización/rollback: solo aserciones de
 *    texto, NUNCA se ejecutan (harían falta permisos de Windows reales y
 *    reemplazarían binarios).
 *
 * CARNAGE_DATA_DIR se sobreescribe antes de requerir cualquier módulo del
 * cliente para no tocar el %LOCALAPPDATA%\CarnageReporter real (ver el
 * mismo comentario en updater.test.js).
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

process.env.CARNAGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-release-test-'));

const { test } = require('node:test');
const assert = require('assert');

const {
    parseSha256Sums, sha256File, verifySha256, verifySignature,
    buildSwapBatScript, buildUpdateBatContent, buildRollbackBatContent
} = require('../src/updater');
const { signFile } = require('../scripts/sign-release');

function tmpFile(name, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-release-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
}

console.log('\n— parseSha256Sums —');

test('formato estándar de sha256sum ("<hash>  nombre")', () => {
    const hash = '1'.repeat(64);
    const map = parseSha256Sums(`${hash}  CarnageReporter.exe\n`);
    assert.strictEqual(map.get('CarnageReporter.exe'), hash);
});

test('formato binario de sha256sum ("<hash> *nombre")', () => {
    const hash = 'a'.repeat(64);
    const map = parseSha256Sums(`${hash} *CarnageReporter.exe\n`);
    assert.strictEqual(map.get('CarnageReporter.exe'), hash);
});

test('varias líneas, CRLF, líneas vacías y basura mezcladas', () => {
    const h1 = '2'.repeat(64);
    const h2 = '3'.repeat(64);
    const text = `${h1}  CarnageReporter.exe\r\n\r\n${h2}  CarnageReporter-Setup.exe\r\nesto no es una línea válida\r\n`;
    const map = parseSha256Sums(text);
    assert.strictEqual(map.size, 2);
    assert.strictEqual(map.get('CarnageReporter.exe'), h1);
    assert.strictEqual(map.get('CarnageReporter-Setup.exe'), h2);
});

test('texto vacío o ausente -> Map vacío, no truena', () => {
    assert.strictEqual(parseSha256Sums('').size, 0);
    assert.strictEqual(parseSha256Sums(undefined).size, 0);
});

console.log('\n— verifySha256 —');

test('hash correcto -> true', () => {
    const file = tmpFile('CarnageReporter.exe', 'contenido de prueba');
    const expected = sha256File(file);
    assert.strictEqual(verifySha256(file, expected), true);
    // Insensible a mayúsculas/minúsculas del hash esperado
    assert.strictEqual(verifySha256(file, expected.toUpperCase()), true);
});

test('hash incorrecto -> false', () => {
    const file = tmpFile('CarnageReporter.exe', 'contenido de prueba');
    assert.strictEqual(verifySha256(file, '0'.repeat(64)), false);
});

test('sin hash esperado o archivo inexistente -> false, no truena', () => {
    assert.strictEqual(verifySha256('/ruta/que/no/existe.exe', 'a'.repeat(64)), false);
    const file = tmpFile('CarnageReporter.exe', 'x');
    assert.strictEqual(verifySha256(file, undefined), false);
});

console.log('\n— verifySignature (Ed25519, clave generada en la prueba) —');

test('firma válida sobre los bytes exactos -> true', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const data = Buffer.from(`${'a'.repeat(64)}  CarnageReporter.exe\n`);
    const signature = crypto.sign(null, data, privateKey).toString('base64');

    assert.strictEqual(verifySignature(data, signature, publicPem), true);
});

test('un solo byte alterado en los datos firmados invalida la firma (y no toca nada más)', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const original = Buffer.from(`${'b'.repeat(64)}  CarnageReporter.exe\n`);
    const signature = crypto.sign(null, original, privateKey).toString('base64');

    const tampered = Buffer.from(original);
    tampered[0] = tampered[0] ^ 0xff; // voltea un byte

    assert.strictEqual(verifySignature(original, signature, publicPem), true, 'control: los datos originales sí deben verificar');
    assert.strictEqual(verifySignature(tampered, signature, publicPem), false, 'un byte volteado debe invalidar la firma');
});

test('firma de otra clave (no la que corresponde) -> false', () => {
    const keyA = crypto.generateKeyPairSync('ed25519');
    const keyB = crypto.generateKeyPairSync('ed25519');
    const publicPemB = keyB.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const data = Buffer.from('SHA256SUMS de prueba');
    const signature = crypto.sign(null, data, keyA.privateKey).toString('base64');

    assert.strictEqual(verifySignature(data, signature, publicPemB), false);
});

test('firma corrupta / no-base64 -> false, no truena', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    assert.strictEqual(verifySignature(Buffer.from('datos'), 'esto no es base64 válido de firma', publicPem), false);
});

console.log('\n— sign-release.js (firma en CI): round-trip con clave generada en la prueba —');

test('signFile firma SHA256SUMS y el .sig resultante verifica con la clave pública correspondiente', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const sumsPath = tmpFile('SHA256SUMS', `${'c'.repeat(64)}  CarnageReporter.exe\n`);
    const sigPath = signFile(sumsPath, privatePem);

    assert.strictEqual(sigPath, `${sumsPath}.sig`);
    assert.ok(fs.existsSync(sigPath));

    const sumsData = fs.readFileSync(sumsPath);
    const sigText = fs.readFileSync(sigPath, 'utf-8');
    assert.strictEqual(verifySignature(sumsData, sigText, publicPem), true);
});

test('signFile: si SHA256SUMS cambia después de firmarlo, la firma vieja deja de verificar', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const sumsPath = tmpFile('SHA256SUMS', `${'d'.repeat(64)}  CarnageReporter.exe\n`);
    const sigPath = signFile(sumsPath, privatePem);
    const sigText = fs.readFileSync(sigPath, 'utf-8');

    fs.writeFileSync(sumsPath, `${'e'.repeat(64)}  CarnageReporter.exe\n`); // se modifica DESPUÉS de firmar
    const tamperedData = fs.readFileSync(sumsPath);

    assert.strictEqual(verifySignature(tamperedData, sigText, publicPem), false);
});

console.log('\n— generación de los .bat de actualización/rollback (solo texto, nunca se ejecutan) —');

test('buildSwapBatScript: espera el PID, mueve en orden y se autodestruye', () => {
    const bat = buildSwapBatScript({
        pid: 4242,
        moves: [{ from: 'C:\\a.exe', to: 'C:\\b.exe' }],
        postMoveLines: ['echo listo >> "C:\\log.txt"'],
        relaunch: 'start "" "C:\\a.exe"',
        logFile: 'C:\\log.txt',
        selfPath: 'C:\\updater.bat'
    });

    assert.ok(bat.includes('tasklist /FI "PID eq 4242"'));
    assert.ok(bat.includes('move /y "C:\\a.exe" "C:\\b.exe"'));
    assert.ok(bat.includes('start "" "C:\\a.exe"'));
    assert.ok(bat.includes('del /f /q "C:\\updater.bat"'), 'debe autodestruirse al final');
    // El movimiento debe ir ANTES del relanzamiento, y el relanzamiento antes del auto-borrado
    const moveIdx = bat.indexOf('move /y');
    const relaunchIdx = bat.indexOf('start "" "C:\\a.exe"');
    const delIdx = bat.lastIndexOf('del /f /q "C:\\updater.bat"');
    assert.ok(moveIdx < relaunchIdx && relaunchIdx < delIdx);
});

test('buildUpdateBatContent: exe actual -> prev.exe, exe nuevo -> exe actual, y escribe update-state.json', () => {
    const bat = buildUpdateBatContent({
        pid: 111,
        currentExe: 'C:\\App\\CarnageReporter.exe',
        newExe: 'C:\\Data\\updates\\1.7.0.exe',
        prevExe: 'C:\\App\\CarnageReporter.prev.exe',
        fromVersion: '1.6.0',
        toVersion: '1.7.0',
        relaunch: 'start "" "C:\\App\\CarnageReporter.exe"',
        logFile: 'C:\\Data\\update.log',
        batPath: 'C:\\Data\\updater.bat',
        stateFile: 'C:\\Data\\update-state.json'
    });

    assert.ok(bat.includes('move /y "C:\\App\\CarnageReporter.exe" "C:\\App\\CarnageReporter.prev.exe"'));
    assert.ok(bat.includes('move /y "C:\\Data\\updates\\1.7.0.exe" "C:\\App\\CarnageReporter.exe"'));
    assert.ok(bat.includes('"C:\\Data\\update-state.json"'), 'debe escribir update-state.json');
    assert.ok(bat.includes('"from":"1.6.0"'));
    assert.ok(bat.includes('"to":"1.7.0"'));

    // El respaldo (current -> prev) debe ocurrir ANTES de instalar el nuevo exe
    const backupIdx = bat.indexOf('CarnageReporter.prev.exe"');
    const installIdx = bat.indexOf('1.7.0.exe" "C:\\App\\CarnageReporter.exe"');
    assert.ok(backupIdx < installIdx);
});

test('buildRollbackBatContent: intercambia exe actual y prev.exe (con archivo temporal) y borra update-state.json', () => {
    const bat = buildRollbackBatContent({
        pid: 222,
        currentExe: 'C:\\App\\CarnageReporter.exe',
        prevExe: 'C:\\App\\CarnageReporter.prev.exe',
        relaunch: 'start "" "C:\\App\\CarnageReporter.exe"',
        logFile: 'C:\\Data\\update.log',
        batPath: 'C:\\Data\\updater.bat',
        stateFile: 'C:\\Data\\update-state.json'
    });

    const tempFile = 'C:\\App\\CarnageReporter.exe.rollback_tmp';
    const step1 = `move /y "C:\\App\\CarnageReporter.exe" "${tempFile}"`;
    const step2 = `move /y "C:\\App\\CarnageReporter.prev.exe" "C:\\App\\CarnageReporter.exe"`;
    const step3 = `move /y "${tempFile}" "C:\\App\\CarnageReporter.prev.exe"`;

    assert.ok(bat.includes(step1));
    assert.ok(bat.includes(step2));
    assert.ok(bat.includes(step3));
    assert.ok(bat.indexOf(step1) < bat.indexOf(step2), 'el respaldo a un temporal debe ir primero');
    assert.ok(bat.indexOf(step2) < bat.indexOf(step3), 'el temporal se recoloca al final');
    assert.ok(bat.includes('del /f /q "C:\\Data\\update-state.json"'), 'ya no hay "actualización reciente" que ofrecer revertir de nuevo');

    // Nunca debe ejecutarse desde la prueba: solo se afirma sobre el texto.
});
