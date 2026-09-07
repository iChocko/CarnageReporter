# Tests - CarnageReporter

Los tests unitarios viven junto al código que prueban, no aquí:

- `server/test/*.test.js` — utils y servicios del servidor (Node.js test runner).
  Se corren con `npm --prefix server test` (o `npm test` desde la raíz, que
  corre server y client).
- `client/test/*.test.js` — modo automático del cliente (autoarranque,
  settings.json, auto-update). Se corren con `npm --prefix client test`.

Este directorio (`tests/`) se mantiene solo por compatibilidad con rutas
viejas; ya no contiene archivos de test.

`test_stats_envios.js` (que vivía aquí) se eliminó en la Fase A0: era un
test roto que dependía de `server/.env` (inexistente en el repo) y de
servicios 100% mockeados con `Math.random()`, así que no probaba nada real.

## Agregar nuevos tests

1. Crea `server/test/<nombre>.test.js` o `client/test/<nombre>.test.js`.
2. Usa `node:test` (`const { test } = require('node:test');`) y `assert`.
3. `node --test` los descubre automáticamente (no hace falta tocar
   `package.json` por cada archivo nuevo).
