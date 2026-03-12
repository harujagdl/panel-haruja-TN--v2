# Flujo de PDF de apartados en Google Drive (Apps Script)

Esta integración deja preparado el backend para persistir y reemplazar el PDF del ticket en Drive sin depender del frontend.

## Variables de entorno en Vercel

- `APARTADOS_PDF_SYNC_URL`: URL del Web App de Google Apps Script.
- `APARTADOS_PDF_SYNC_TOKEN`: token compartido opcional para validar requests (`Authorization: Bearer ...`).

## Cuándo se dispara

`api/apartados/[folio].js` ejecuta sincronización en:

1. Alta de apartado (`reason: create`)
2. Registro de abono (`reason: abono`)
3. Consulta de status (`reason: status_lookup`, útil para recuperar URL del PDF más reciente)

## Contrato esperado con Apps Script

Request `POST` JSON:

```json
{
  "folio": "HARUJA0001",
  "reason": "create|abono|status_lookup",
  "apartado": { "...": "datos del apartado" },
  "source": "panel-haruja",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

Response esperada:

```json
{
  "ok": true,
  "pdfUrl": "https://drive.google.com/file/d/.../view"
}
```

## Lógica recomendada en Apps Script

1. Buscar por nombre fijo (`HARUJA0001.pdf`) en carpeta destino por ID.
2. Si existe, eliminar/reemplazar con nueva versión.
3. Si no existe, crear archivo PDF.
4. Devolver `pdfUrl` actual para mostrar en `/apartado/:folio`.

## Nota

Si no se definen variables de entorno, la app sigue funcionando sin bloquear el alta/abono; solo omite la sincronización de Drive.


## Endpoints puente en Vercel

- `GET /api/pdf-apartado/{folio}`: consulta si existe el PDF persistente y regresa `pdfUrl`, `exists`, `updatedAt`.
- `POST /api/pdf-apartado/{folio}/refresh`: fuerza regeneración/reemplazo del PDF vigente y regresa la URL actualizada.

Ambos endpoints delegan en `lib/apartados/pdf-sync.js` y mantienen la lógica sensible fuera del frontend.
