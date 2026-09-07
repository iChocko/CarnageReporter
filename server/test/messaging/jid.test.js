/**
 * Tests de server/messaging/jid.js (Fase A3): identidad transporte-neutral.
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');

const {
    identityFromJid, identityKeys, identityFromKeys,
    sameIdentity, mergeIdentity, mentionUserPart, toLegacyJid, parseIdList,
} = require('../../messaging/jid');

console.log('\n— identityFromJid —');

test('JID de teléfono clásico (@c.us) -> pn', () => {
    assert.deepStrictEqual(identityFromJid('5215551234567@c.us'), { pn: '5215551234567' });
});

test('JID de teléfono forma nueva (@s.whatsapp.net) -> pn', () => {
    assert.deepStrictEqual(identityFromJid('5215551234567@s.whatsapp.net'), { pn: '5215551234567' });
});

test('JID @lid -> lid', () => {
    assert.deepStrictEqual(identityFromJid('123456789@lid'), { lid: '123456789' });
});

test('JID @lid con sufijo :device se le quita el device', () => {
    assert.deepStrictEqual(identityFromJid('123456789:5@lid'), { lid: '123456789' });
});

test('@c.us con :device también se le quita el device', () => {
    assert.deepStrictEqual(identityFromJid('5215551234567:0@c.us'), { pn: '5215551234567' });
});

test('dígitos sueltos (sin @) se tratan como pn', () => {
    assert.deepStrictEqual(identityFromJid('5215551234567'), { pn: '5215551234567' });
});

test('null/undefined/vacío/basura -> {}', () => {
    assert.deepStrictEqual(identityFromJid(null), {});
    assert.deepStrictEqual(identityFromJid(undefined), {});
    assert.deepStrictEqual(identityFromJid(''), {});
    assert.deepStrictEqual(identityFromJid('@c.us'), {}); // sin dígitos
    assert.deepStrictEqual(identityFromJid('status@broadcast'), {});
});

console.log('\n— identityKeys / identityFromKeys —');

test('identityKeys: orden fijo pn, lid', () => {
    assert.deepStrictEqual(identityKeys({ pn: '1', lid: '2' }), ['pn:1', 'lid:2']);
    assert.deepStrictEqual(identityKeys({ lid: '2' }), ['lid:2']);
    assert.deepStrictEqual(identityKeys({}), []);
    assert.deepStrictEqual(identityKeys(undefined), []);
});

test('identityFromKeys es el inverso de identityKeys', () => {
    const id = { pn: '5215551234567', lid: '999' };
    assert.deepStrictEqual(identityFromKeys(identityKeys(id)), id);
});

test('identityFromKeys ignora claves con forma inválida', () => {
    assert.deepStrictEqual(identityFromKeys(['pn:abc', 'lid:123', 'basura', null]), { lid: '123' });
});

console.log('\n— sameIdentity —');

test('mismo pn -> true', () => {
    assert.ok(sameIdentity({ pn: '1' }, { pn: '1', lid: '9' }));
});

test('mismo lid -> true', () => {
    assert.ok(sameIdentity({ lid: '9' }, { pn: '1', lid: '9' }));
});

test('sin overlap -> false', () => {
    assert.ok(!sameIdentity({ pn: '1' }, { pn: '2' }));
});

test('identidad vacía nunca es igual a nada (ni a sí misma)', () => {
    assert.ok(!sameIdentity({}, {}));
    assert.ok(!sameIdentity({}, { pn: '1' }));
});

console.log('\n— mergeIdentity —');

test('combina pn y lid de dos identidades parciales', () => {
    assert.deepStrictEqual(mergeIdentity({ pn: '1' }, { lid: '2' }), { pn: '1', lid: '2' });
});

test('el primer argumento tiene prioridad si ambos traen el mismo campo', () => {
    assert.deepStrictEqual(mergeIdentity({ pn: '1' }, { pn: '2' }), { pn: '1' });
});

console.log('\n— mentionUserPart —');

test('devuelve los dígitos listos para el token "@<dígitos>"', () => {
    assert.strictEqual(mentionUserPart('5215551234567@c.us'), '5215551234567');
    assert.strictEqual(mentionUserPart('123@lid'), '123');
    assert.strictEqual(mentionUserPart('no-jid'), '');
});

console.log('\n— toLegacyJid —');

test('prioriza pn sobre lid', () => {
    assert.strictEqual(toLegacyJid({ pn: '1', lid: '2' }), '1@c.us');
});

test('cae a lid si no hay pn', () => {
    assert.strictEqual(toLegacyJid({ lid: '2' }), '2@lid');
});

test('identidad vacía -> null', () => {
    assert.strictEqual(toLegacyJid({}), null);
    assert.strictEqual(toLegacyJid(undefined), null);
});

console.log('\n— parseIdList (formato histórico WHATSAPP_ADMIN_JIDS) —');

test('parsea una lista separada por comas con espacios', () => {
    const list = parseIdList('5215551234567@c.us, 123@lid ,, 5215559876543@c.us');
    assert.deepStrictEqual(list, [
        { pn: '5215551234567' },
        { lid: '123' },
        { pn: '5215559876543' },
    ]);
});

test('string vacía o undefined -> []', () => {
    assert.deepStrictEqual(parseIdList(''), []);
    assert.deepStrictEqual(parseIdList(undefined), []);
});

test('entradas sin dígitos se descartan', () => {
    assert.deepStrictEqual(parseIdList('status@broadcast,5215551234567@c.us'), [{ pn: '5215551234567' }]);
});
