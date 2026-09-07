/**
 * Tests de la migración de roster v1 -> v2 (Fase A3): server/utils/roster.js
 * ya no guarda JIDs crudos (`jids`) sino claves de Identity (`ids`, ver
 * server/messaging/jid.js). El roster de prod (grupo Retas H3) está
 * sembrado con LIDs reales que la migración NO debe perder ni duplicar.
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const roster = require('../utils/roster');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roster-v2-'));

function writeRosterFile(dir, data) {
    fs.writeFileSync(path.join(dir, roster.ROSTER_FILE), JSON.stringify(data));
}

console.log('\n— migración v1 -> v2 —');

test('un archivo v1 (jids) se lee como v2 (ids) con las claves correctas', () => {
    const dir = tmpDir();
    writeRosterFile(dir, {
        version: 1,
        links: [
            { jids: ['5215551234567@c.us', '999@lid'], gamertag: 'Axtorion', known: true, linkedAt: '2024-01-01T00:00:00.000Z', linkedBy: 'admin' },
        ],
    });

    const loaded = roster.loadRoster(dir);
    assert.strictEqual(loaded.version, 2);
    assert.strictEqual(loaded.links.length, 1);
    assert.deepStrictEqual(new Set(loaded.links[0].ids), new Set(['pn:5215551234567', 'lid:999']));
    assert.strictEqual(loaded.links[0].gamertag, 'Axtorion');
    assert.strictEqual(loaded.links[0].known, true);
});

test('LIDs reales de prod sobreviven la migración sin perderse ni duplicarse', () => {
    const dir = tmpDir();
    // Forma real de un LID sembrado en prod (ver memoria del proyecto): dígitos largos, sin device.
    writeRosterFile(dir, {
        version: 1,
        links: [
            { jids: ['218374659172834@lid'], gamertag: 'lChocko', known: true },
            { jids: ['5215512345678@c.us', '187263549182734@lid'], gamertag: 'Rober K15 Mx', known: true },
        ],
    });

    const loaded = roster.loadRoster(dir);
    const lChocko = roster.findByGamertag(loaded, 'lchocko');
    const rober = roster.findByGamertag(loaded, 'rober k15 mx');
    assert.deepStrictEqual(lChocko.ids, ['lid:218374659172834']);
    assert.deepStrictEqual(new Set(rober.ids), new Set(['pn:5215512345678', 'lid:187263549182734']));

    // Se resuelve por LID exactamente igual que antes de migrar.
    assert.strictEqual(roster.findByIdentity(loaded, { lid: '218374659172834' }).gamertag, 'lChocko');
    assert.strictEqual(roster.findByJid(loaded, '218374659172834@lid').gamertag, 'lChocko');
});

test('un LID con sufijo :device se normaliza igual que uno sin device', () => {
    const dir = tmpDir();
    writeRosterFile(dir, {
        version: 1,
        links: [{ jids: ['999888777:0@lid'], gamertag: 'ConDevice', known: true }],
    });
    const loaded = roster.loadRoster(dir);
    assert.deepStrictEqual(loaded.links[0].ids, ['lid:999888777']);
    assert.strictEqual(roster.findByJid(loaded, '999888777@lid').gamertag, 'ConDevice');
});

console.log('\n— idempotencia —');

test('migrar dos veces (guardar y volver a cargar) da el mismo resultado', () => {
    const dir = tmpDir();
    writeRosterFile(dir, {
        version: 1,
        links: [{ jids: ['5215551234567@c.us', '999@lid'], gamertag: 'Axtorion', known: true, linkedAt: '2024-01-01T00:00:00.000Z', linkedBy: 'admin' }],
    });

    const first = roster.loadRoster(dir);
    roster.saveRoster(dir, first);
    const second = roster.loadRoster(dir);

    assert.deepStrictEqual(second, first);
    assert.strictEqual(second.version, 2);
});

test('un archivo ya v2 pasa sin cambios por loadRoster (idempotente)', () => {
    const dir = tmpDir();
    const v2 = {
        version: 2,
        links: [{ ids: ['pn:5215551234567', 'lid:999'], gamertag: 'Axtorion', known: true, linkedAt: '2024-01-01T00:00:00.000Z', linkedBy: 'admin' }],
    };
    writeRosterFile(dir, v2);
    const loaded = roster.loadRoster(dir);
    assert.deepStrictEqual(loaded, v2);
});

console.log('\n— archivos mixtos v1/v2 —');

test('un archivo con links v1 y v2 mezclados migra ambos correctamente', () => {
    const dir = tmpDir();
    writeRosterFile(dir, {
        version: 2,
        links: [
            { jids: ['5215551111111@c.us'], gamertag: 'ViejoEstilo', known: true }, // aún v1 (typo de un merge manual, por ejemplo)
            { ids: ['pn:5215552222222'], gamertag: 'NuevoEstilo', known: false, linkedAt: '2024-01-01T00:00:00.000Z', linkedBy: 'self' },
        ],
    });

    const loaded = roster.loadRoster(dir);
    assert.strictEqual(loaded.links.length, 2);
    assert.deepStrictEqual(roster.findByGamertag(loaded, 'ViejoEstilo').ids, ['pn:5215551111111']);
    assert.deepStrictEqual(roster.findByGamertag(loaded, 'NuevoEstilo').ids, ['pn:5215552222222']);
});

test('un link sin ids ni jids válidos se descarta sin tronar', () => {
    const dir = tmpDir();
    writeRosterFile(dir, {
        version: 1,
        links: [
            { gamertag: 'SinIdentidad' },
            { jids: [], gamertag: 'JidsVacios' },
            { jids: ['no-son-digitos@c.us'], gamertag: 'SinDigitos' },
            { jids: ['5215559999999@c.us'], gamertag: 'ConDigitos' },
        ],
    });
    const loaded = roster.loadRoster(dir);
    assert.strictEqual(loaded.links.length, 1);
    assert.strictEqual(loaded.links[0].gamertag, 'ConDigitos');
});

console.log('\n— linkJid / addAlias / findByIdentity sobre v2 —');

test('linkJid acepta un JID crudo, una Identity, o una clave ya normalizada', () => {
    const data = { version: 2, links: [] };
    const r1 = roster.linkJid(data, '5215551234567@c.us', 'Uno', {});
    assert.ok(r1.ok);
    const r2 = roster.linkJid(data, { lid: '999' }, 'Dos', {});
    assert.ok(r2.ok);
    const r3 = roster.linkJid(data, 'pn:5215557654321', 'Tres', {});
    assert.ok(r3.ok);
    assert.strictEqual(data.links.length, 3);
    assert.deepStrictEqual(r2.link.ids, ['lid:999']);
    assert.deepStrictEqual(r3.link.ids, ['pn:5215557654321']);
});

test('addAlias con una Identity agrega la clave sin duplicar', () => {
    const data = { version: 2, links: [] };
    const { link } = roster.linkJid(data, '5215551234567@c.us', 'Uno', {});
    roster.addAlias(link, { lid: '111' });
    roster.addAlias(link, { lid: '111' });
    assert.deepStrictEqual(new Set(link.ids), new Set(['pn:5215551234567', 'lid:111']));
});

test('findByIdentity resuelve por cualquiera de las dos formas conocidas', () => {
    const data = { version: 2, links: [{ ids: ['pn:5215551234567', 'lid:111'], gamertag: 'Uno', known: true, linkedAt: 'x', linkedBy: 'x' }] };
    assert.strictEqual(roster.findByIdentity(data, { pn: '5215551234567' }).gamertag, 'Uno');
    assert.strictEqual(roster.findByIdentity(data, { lid: '111' }).gamertag, 'Uno');
    assert.strictEqual(roster.findByIdentity(data, { pn: '000' }), null);
});
