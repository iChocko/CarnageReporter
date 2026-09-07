# Scripts legacy

Scripts sueltos de la raíz del repo, movidos aquí en la Fase A0 por
higiene. **No están mantenidos**: no corren en CI, no los ejecuta
`deploy.sh` ni ningún workflow, y pueden requerir variables de entorno o
estado de la base de datos que ya no existen.

- `test_4v4.js`, `test_discord_envio.js`, `test_full_production_flow.js`,
  `test_realistic_flow.js` — scripts manuales de prueba de flujo completo
  (envío a Discord, generación de PNG, etc.) de antes de que existieran los
  tests en `server/test/` y `client/test/`.
- `verificar_correcciones.js`, `verificar_supabase.js`, `check_setup.js` —
  scripts de verificación manual (setup local, estado de Supabase).
- `ejecutar_migracion.js` — corredor de migraciones ad-hoc de una versión
  anterior del esquema de Supabase (el esquema actual vive en
  `server/supabase_schema.sql` y se aplica a mano en el SQL editor).

Si necesitas reactivar alguno, revisa primero si sigue siendo compatible
con el esquema y las variables de entorno actuales.
