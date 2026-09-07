# 🎮 Carnage Reporter v3.0

[![Halo 3 MCC](https://img.shields.io/badge/Game-Halo%203%20MCC-blue?style=for-the-badge&logo=xbox)](https://www.halowaypoint.com/)
[![Node.js](https://img.shields.io/badge/Powered%20By-Node.js-green?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![Discord](https://img.shields.io/badge/Community-Discord-7289DA?style=for-the-badge&logo=discord)](https://discord.gg/yD6nGZ3KQX)
[![Supabase](https://img.shields.io/badge/Database-Supabase-3ECF8E?style=for-the-badge&logo=supabase)](https://supabase.com/)

---

### 🚀 DESCARGA DIRECTA
> [!IMPORTANT]
> **[📥 Descargar CarnageReporter.exe para PC](https://github.com/iChocko/CarnageReporter/releases/latest/download/CarnageReporter.exe)**
> *Compatible con Windows 10/11 (Halo 3 MCC PC).*

> [!NOTE]
> **¿Windows bloquea la descarga o aparece "Editor: Desconocido"?** Es SmartScreen y es normal
> (el ejecutable aún no está firmado digitalmente; el código es abierto y puedes revisarlo aquí mismo).
> - **Al descargar**: en la barra de descargas → ⋯ → **Conservar** → "Mostrar más" → **Conservar de todas formas**.
> - **Al abrir**: clic en **"Más información"** → **"Ejecutar de todas formas"** (solo la primera vez).

<sub>🔐 Free code signing on Windows provided by [SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org) *(en proceso de integración)*. Consulta la
[Política de Privacidad](PRIVACY.md) para saber qué datos procesa la aplicación.</sub>

---

## 📌 Sobre este proyecto
Este proyecto es un **fork mejorado** del trabajo original de [CYRiXplaysHalo/CarnageReporter](https://github.com/CYRiXplaysHalo/CarnageReporter). Se ha rediseñado para ofrecer una arquitectura más robusta, integración con Supabase para estadísticas históricas y un dashboard web completo.

**Carnage Reporter** automatiza el seguimiento de tus partidas de Halo 3 en MCC PC (Customs y Matchmaking), extrayendo estadísticas detalladas que el juego normalmente sobreescribe.

---

## 🛠️ ¿Cómo funciona?

El ecosistema se divide en tres componentes principales que trabajan en armonía:

### 1. 🖥️ El Cliente (App de Escritorio)
Es un ejecutable ligero que corre en segundo plano mientras juegas:
- **Monitoreo en Tiempo Real**: Vigila la carpeta temporal de MCC en busca de los archivos `.xml` que el juego genera tras cada partida.
- **Persistencia**: Antes de que MCC los borre, el cliente los captura y procesa.
- **Sincronización**: Envía los datos extraídos automáticamente a nuestro servidor central.

### 2. 🌐 El Servidor (Backend)
El cerebro del sistema, encargado de procesar la "carnicería":
- **Procesamiento de Datos**: Recibe el XML, lo parsea y extrae cada baja, muerte, asistencia y medalla.
- **Renderizado Dinámico**: Utiliza un motor de renderizado (Puppeteer) para crear una imagen resumida (PNG) profesional de la partida.
- **Notificaciones**: Publica automáticamente los resultados en canales de **Discord** y grupos de **WhatsApp**.
- **Base de Datos**: Almacena cada estadística en **Supabase** de por vida.

### 3. 📊 El Dashboard (Web)
Una interfaz moderna construida en React para la comunidad:
- **Leaderboards**: Clasificación en tiempo real de los mejores jugadores basada en métricas MLG.
- **Historial Global**: Visualiza el total de bajas, muertes y eficiencia de toda la comunidad.
- **Perfiles**: Consulta tus estadísticas personales y evolución a lo largo del tiempo.

---

## 🔧 Configuración para Desarrolladores

Si deseas correr el proyecto desde el código fuente o contribuir:

1. **Clonar el repo**:
   ```bash
   git clone https://github.com/iChocko/CarnageReporter.git
   ```
2. **Instalar dependencias**:
   ```bash
   npm install
   ```
3. **Variables de entorno**:
   Configura un archivo `.env` basado en `.env.example` (todas las variables están documentadas ahí):
   ```env
   API_KEY=una-cadena-aleatoria-larga
   SUPABASE_URL=https://tu-proyecto.supabase.co
   SUPABASE_KEY=tu_service_role_key
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
   ```
4. **Ejecutar**:
   - Cliente: `npm start`
   - Servidor: `node server/index.js`
   - Dashboard: `cd dashboard && npm run dev`
5. **Compilar el cliente (.exe de Windows)**:
   ```bash
   ./build_client.sh
   # o directamente:
   cd client && npm install && npm run build
   ```
   Genera `client/dist/CarnageReporter.exe` con [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg)
   (fork mantenido de `pkg`, targeting `node22-win-x64`). Ver
   [`docs/sea-fallback.md`](docs/sea-fallback.md) para la alternativa con
   Node SEA si el empaquetador deja de funcionar.

   El ejecutable (y `node client/carnage_client.js` en desarrollo) acepta
   además de `--background`:
   - `--version`: imprime la versión y sale (código 0).
   - `--selftest`: corre el parser XML real contra un fixture interno y sale
     0/1 — útil para verificar un build recién compilado sin tener un XML
     real de una partida.
   - `--status`: imprime `status.json` si existe (o consulta la instancia
     corriendo en `127.0.0.1:47613` como respaldo) y sale (código 0).
   - `--enable-autostart` / `--disable-autostart`: activa o desactiva el
     arranque automático con Windows sin pasar por el menú interactivo.
   - `--drain-now`: reintenta de inmediato lo que esté en la cola de envío
     (spool), sin esperar al timer de 60s ni a que llegue una partida nueva.

   **Dónde vive cada cosa (desde v1.7 / Fase B3)**: `settings.json`, la
   bitácora (`carnage_client.log`), la cola de reportes pendientes/fallidos
   (`spool/`), `status.json` e `instance.json` ya NO viven junto al exe sino
   en `%LOCALAPPDATA%\CarnageReporter` (o `CARNAGE_DATA_DIR` si lo defines).
   El `config.json`/`config.gen.js` con la API key sigue leyéndose junto al
   exe. Un `settings.json`/`carnage_autostart.vbs` de una instalación anterior
   se migra (copia) automáticamente la primera vez que corre esta versión.

   **Reportes robustos (spool)**: un XML que no se pudo enviar (sin
   conexión, servidor caído) se mueve a `spool\pending\` y se reintenta con
   backoff creciente (5s, 15s, 1m, 5m, 15m, hasta 1h) durante 7 días antes de
   archivarse en `spool\failed\`. Sobrevive a que cierres el programa o se
   reinicie Windows a la mitad. `CARNAGE_LOG_LEVEL=debug` (o
   `settings.json: { "logLevel": "debug" }`) agrega detalle extra a la
   bitácora.

---

## 🤝 Créditos y Agradecimientos
- **Autor Original**: [CYRiXplaysHalo](https://github.com/CYRiXplaysHalo) (Idea inicial y estructura de captura XML).
- **Mantenedor Actual**: [iChocko](https://github.com/iChocko).
- **Comunidad**: Gracias a todos los jugadores que contribuyen con su data para hacer de Halo 3 un juego eterno.

---

<p align="center">
  Hecho con ❤️ para la comunidad de Halo.
</p>
