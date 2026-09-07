# Plan B: Node.js SEA en vez de @yao-pkg/pkg

El cliente empaqueta con `@yao-pkg/pkg` (fork mantenido de `pkg`, el original
está archivado). Si ese fork se estanca (deja de seguir versiones de Node,
rompe con Node 22/24, o el proyecto se abandona), la alternativa es el
**Single Executable Applications** nativo de Node.js — sin depender de un
tercero para el empaquetado.

## Por qué no se usa ya

SEA todavía pide más pasos manuales (bundle propio, inyección de blob con
`postject`, sin soporte nativo de `assets` como `pkg`) y en Windows no
genera un `.exe` autocontenido tan directo — hay que copiar el binario de
`node.exe` y pegarle el blob. Para un solo target (`node22-win-x64`) vale la
pena mientras `@yao-pkg/pkg` siga funcionando.

## Pasos para migrar si hace falta

1. **Bundlear a un solo archivo** con `esbuild` (el cliente usa `require()`
   de CommonJS, así que un bundle plano basta — no hace falta bundlear
   `node_modules` nativos porque no los hay):
   ```bash
   npx esbuild client/carnage_client.js --bundle --platform=node \
     --target=node22 --outfile=build/bundle.js
   ```

2. **Generar el blob SEA** con la config de Node:
   ```json
   // sea-config.json
   {
     "main": "build/bundle.js",
     "output": "build/sea-prep.blob",
     "disableExperimentalSEAWarning": true
   }
   ```
   ```bash
   node --experimental-sea-config sea-config.json
   ```

3. **Copiar el binario de node y pegarle el blob** (Windows, con
   `postject`):
   ```bash
   cp $(where node) dist/CarnageReporter.exe
   npx postject dist/CarnageReporter.exe NODE_SEA_BLOB build/sea-prep.blob \
     --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
     --overwrite
   ```
   En CI (Windows) puede hacer falta quitar la firma de Authenticode del
   `node.exe` copiado antes de inyectar el blob (`signtool remove /s`), y
   volver a firmar después si se firma con SignPath.

4. **Detectar "empaquetado" sin `process.pkg`**: SEA no define
   `process.pkg`. La detección pasa a ser:
   ```js
   const sea = require('node:sea');
   const isPackaged = sea?.isSea?.() ?? false;
   ```
   (ver `client/src/paths.js` — ya deja el hueco preparado para esto.)

5. **Config y version embebidos**: con `pkg`, `require('./package.json')`
   se resuelve solo porque el bundler lo detecta estáticamente. Con SEA hay
   que embeber la versión en el bundle en tiempo de build (reemplazo de
   texto o `--define` de esbuild) en vez de un `require` en tiempo de
   ejecución, porque el bundle final es un único archivo sin `package.json`
   junto a él.

6. **Actualizar el workflow**: reemplazar el paso "Build executable" por los
   pasos 1–3 de arriba, y el smoke test (`--version` / `--selftest`) se
   mantiene igual porque son flags del propio programa, no del empaquetador.

## Qué no cambia

- `client/src/config.js`, `settings.js`, `sender.js`, `parser.js`, etc. no
  saben ni les importa cómo se empaquetó el binario — solo `paths.js`
  necesita el ajuste de detección del punto 4.
- El auto-update (`updater.js`) sigue reemplazando el `.exe` completo tal
  cual, sin importar si se generó con `pkg` o con SEA.
