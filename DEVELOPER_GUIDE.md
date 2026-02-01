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

- **Auto-Update**: Utiliza un script `.bat` temporal para reemplazar el ejecutale mientras está cerrado.
- **Standalone**: El cliente no requiere `.env` para funcionar en producción.
- **SQL**: Si haces cambios que afecten qué partidas se ven, recuerda actualizar las vistas en Supabase usando `server/update_views_include_all.sql`.
