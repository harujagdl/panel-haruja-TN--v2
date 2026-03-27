# Bloque 9 — Observabilidad quirúrgica (matriz de eventos)

## Archivos intervenidos

- `lib/observability/logger.js`
- `api/core.js`
- `lib/api/apartados.js`
- `lib/api/prendasAdmin.js`
- `lib/apartados/pdf-sync.js`
- `public/shared/apartados-adapter.js`
- `public/apartados/index.html`
- `public/app/apartados/index.html`

## Eventos agregados (backend)

### `api/core.js`
- `api.core.method_not_allowed` (warn): método inválido por acción.
- `api.core.denied` (warn): acceso negado por sesión admin.
- `api.core.failed` (error): fallo general del router principal.
- `admin.session.expired` (warn): sesión ausente/expirada en status.
- `admin.session.login_failed` (error): error al validar login de Google.
- `pdf.proxy.start` / `pdf.proxy.success` / `pdf.proxy.error` / `pdf.proxy.invalid_response`.

**Metadata típica:** `action`, `op`, `traceId`, `stage`, `errorCode`, `result`, `method`.

### `lib/api/apartados.js`
- Abonos:
  - `apartados.abono.start`
  - `apartados.abono.validated`
  - `apartados.abono.history_saved`
  - `apartados.abono.parent_updated`
  - `apartados.abono.duplicated`
  - `apartados.abono.pdf_failed` (partial)
  - `apartados.abono.inconsistent` (inconsistencia)
- Apartados:
  - `apartados.create.start`
  - `apartados.create.success`
  - `apartados.create.partial` (PDF no disponible)
- Estado/cancelación:
  - `apartados.update_status.start`
  - `apartados.update_status.success`
  - `apartados.cancel.start`
- Refresh PDF:
  - `apartados.pdf_refresh.start`
  - `apartados.pdf_refresh.success`
  - `apartados.pdf_refresh.failed`

**Metadata típica:** `folio`, `operationId`, `traceId`, `result`, `errorCode`, `message`.

### `lib/api/prendasAdmin.js`
- `prendas.update.start`
- `prendas.update.invalid_payload` (warn)
- `prendas.update.not_found` (warn)
- `prendas.update.success`

**Metadata típica:** `codigo`, `traceId`, `errorCode`.

### `lib/apartados/pdf-sync.js`
- `apartados.pdf_sync.upload_body`
- `pdf.drive_test.start`
- `pdf.drive_test.success`
- `pdf.drive_test.failed`

**Metadata típica:** `traceId`, `fileId`, `errorCode`, `message`.

## Códigos de respuesta operativos usados en este bloque

- `ADMIN_SESSION_REQUIRED`
- `METHOD_NOT_ALLOWED`
- `SHEETS_QUOTA_EXCEEDED`
- `ADMIN_TEMP_UNAVAILABLE`
- `INVALID_PAYLOAD`
- `APARTADO_NOT_FOUND`
- `ABONO_DUPLICATED`
- `ABONO_INCONSISTENT`
- `PDF_PROXY_FAILED`
- `PRENDA_NOT_FOUND`

## Clasificación operacional

- **Warning:** denegaciones de sesión, método inválido, payload inválido/ignorados, no encontrados.
- **Inconsistencia:** `apartados.abono.inconsistent` (historial guardado y fallo en update padre, o sobregiro detectado).
- **Éxito parcial:** abono/apartado registrado con fallo de PDF (`partial=true` + eventos `*.partial` / `*.pdf_failed`).

## Qué quedó fuera del alcance quirúrgico

- No se integró infraestructura externa (Datadog/Sentry/ELK).
- No se instrumentaron todos los endpoints públicos triviales.
- No se añadió almacenamiento de auditoría dedicado; la auditoría se resolvió con eventos estructurados y trazables.
