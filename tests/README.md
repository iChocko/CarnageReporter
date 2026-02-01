# Tests - CarnageReporter

Este directorio contiene las pruebas para el proyecto CarnageReporter.

## 📋 Tests Disponibles

### Test de Estadísticas de Envíos

**Archivo:** `test_stats_envios.js`

**Descripción:**
Este test verifica el funcionamiento completo del flujo de procesamiento de reportes de partidas, incluyendo:

- ✅ Generación de imágenes PNG
- ✅ Envío a Discord
- ✅ Guardado en Supabase
- ✅ Detección de duplicados
- ✅ Estadísticas de éxito/fallo

**Cómo ejecutar:**

```bash
# Usando npm
npm run test:stats

# O directamente con node
node tests/test_stats_envios.js
```

**Salida esperada:**

El test ejecuta 10 simulaciones de procesamiento de reportes y verifica:

1. **Procesamiento completo:** Todos los reportes deben procesarse correctamente
2. **Generación de imágenes:** Se debe generar una imagen PNG por cada reporte
3. **Almacenamiento en DB:** Todos los juegos deben guardarse en Supabase
4. **Detección de duplicados:** Los juegos repetidos deben ser detectados y saltados
5. **Tasa de éxito:** Discord debe tener una tasa de éxito >= 70%

**Ejemplo de salida:**

```
╔══════════════════════════════════════════════════════════╗
║              ESTADÍSTICAS DE ENVÍOS                      ║
╚══════════════════════════════════════════════════════════╝

📤 DISCORD:
   ✅ Enviados exitosamente: 9
   ❌ Fallidos: 1
   📊 Total intentos: 10
   📈 Tasa de éxito: 90.00%

💾 SUPABASE:
   📁 Juegos guardados: 10
   👥 Jugadores procesados: 80

🎨 RENDERER:
   🖼️  Imágenes generadas: 10

🏆 RESULTADO FINAL: 5/5 tests pasados
   ✅ TODOS LOS TESTS PASARON
```

## 🧪 Agregar Nuevos Tests

Para agregar nuevos tests:

1. Crea un nuevo archivo en este directorio: `test_nombre.js`
2. Sigue la estructura del test existente
3. Agrega un script en `package.json`:
   ```json
   "test:nombre": "node tests/test_nombre.js"
   ```
4. Documenta el test en este README

## 📝 Notas

- Los tests usan servicios mock (simulados) para no hacer llamadas reales a Discord o Supabase
- Los datos de prueba son generados aleatoriamente
- Los tests deben poder ejecutarse múltiples veces sin efectos secundarios
