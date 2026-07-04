# Guía del Desarrollador - CarnageReporter

Esta guía explica cómo gestionar el ciclo de vida del cliente y lanzar nuevas versiones.

## 🚀 Cómo lanzar una nueva versión

El sistema de auto-actualización y el build del `.exe` están automatizados vía GitHub Actions.

1.  **Actualizar la versión en el código**:
    - Abre `client/carnage_client.js`.
    - Cambia la constante `VERSION` (ej: `1.3.0`).
2.  **Commit de los cambios**:
    ```bash
    git add .
    git commit -m "Release v1.3.0: Descripción de cambios"
    ```
3.  **Crear y subir el Tag**:
    ```bash
    git tag v1.3.0
    git push origin main --tags
    ```
4.  **Automatización**:
    - GitHub Actions detectará el tag `v*`.
    - Compilará el `.exe` en Windows.
    - Creará un **GitHub Release** automáticamente con el archivo como asset.
    - Los clientes actuales verán el aviso de "Nueva versión disponible" y se actualizarán solos al reiniciar.

## 🛠️ Notas Técnicas

- **Auto-Update**: Utiliza un script `.bat` temporal para reemplazar el ejecutable mientras está cerrado.
- **API key del cliente**: el CI la inyecta en build desde el secret `CARNAGE_API_KEY`
  (Settings > Secrets and variables > Actions). Sin ese secret, el release falla a propósito.
  Para desarrollo local usa un `config.json` junto al exe o las vars `CARNAGE_API_KEY`/`CARNAGE_SERVER_URL`.
- **SQL**: el schema completo (tablas + vistas) vive en `server/supabase_schema.sql`.
  Se ejecuta una sola vez en el SQL Editor de Supabase. Las vistas filtran
  `is_voided = FALSE AND is_matchmaking = FALSE` — ese es el criterio único de stats.
- **Partidas anuladas**: el servidor las guarda con `is_voided=true` (reason:
  `last_match_incomplete`, `too_short`, `majority_quit` o `manual`). Restaurar:
  `POST /api/admin/games/<id>/unvoid` con header `X-Admin-Key`.
- **Borrar una partida**: el ID corto sale en la imagen (footer). 
  `curl -X DELETE -H "X-Admin-Key: $ADMIN_KEY" https://h3mccstats.cloud/api/admin/games/<id-corto>`
- **WhatsApp**: habilitar con `WHATSAPP_ENABLED=true` en el `.env` del VPS. El QR de
  pairing se sirve en `GET /api/admin/whatsapp/qr` (header `X-Admin-Key`); escanear una vez.
  La sesión persiste en el volumen `wwebjs_auth` del contenedor.

## 🚀 Deploy del servidor (v1.3.0+)

1. Crear `/root/carnage-reporter-docker/.env` en el VPS (ver `.env.example`) — una sola vez.
2. Ejecutar `server/supabase_schema.sql` en el proyecto Supabase (una sola vez).
3. Local: crear `.env.deploy` con `DEPLOY_HOST=<ip-o-dominio>` y correr `./deploy.sh`
   (requiere acceso SSH por llave).
4. Publicar el cliente DESPUÉS del servidor (el servidor acepta payloads v1 y v2).
