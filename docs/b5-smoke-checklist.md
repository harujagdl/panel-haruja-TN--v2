# B5 — Smoke tests y checklist final de estabilidad

> Objetivo: validar rápidamente que los bloques A, B1, B2, B3 y B4 no rompieron flujos críticos.

## Pre-requisitos

- Tener URL base del entorno (ejemplo: `https://<deploy>.vercel.app`).
- Tener una sesión de admin válida (cookie de `admin-session`) para pruebas autenticadas.
- Contar con 1 folio de apartado de prueba (o crear uno en el paso 6).
- Tener acceso de lectura a logs de funciones (`/api/core`, `/api/ventas/sync`, `/api/tiendanube/webhook`).
- Tener acceso a Google Sheets usadas por el sistema.

Variables sugeridas:

```bash
export BASE_URL="https://<deploy>.vercel.app"
export ADMIN_COOKIE='admin-session=<cookie_valida>'
export FOLIO_TEST='A-TEST-001'
export TN_HMAC='sha256=<firma_valida>'
```

---

## 1) Auth

### 1.1 Endpoint sensible sin sesión responde 401

**Request sugerido**

```bash
curl -i "$BASE_URL/api/core?action=apartados&op=cancel" \
  -X POST \
  -H 'content-type: application/json' \
  --data '{"folio":"'$FOLIO_TEST'"}'
```

**Resultado esperado**

- HTTP `401`.
- Código de error tipo `ADMIN_SESSION_REQUIRED` (o mensaje equivalente de sesión admin requerida).

**Revisar en logs/consola**

- Evento/linea de denegación para `apartados op denied`.

### 1.2 Endpoint sensible con admin funciona

**Request sugerido**

```bash
curl -i "$BASE_URL/api/core?action=apartados&op=detail&folio=$FOLIO_TEST" \
  -H "cookie: $ADMIN_COOKIE"
```

**Resultado esperado**

- HTTP `200`.
- `ok: true` + payload de apartado.

**Revisar en logs/consola**

- Sin errores `401`.
- Si aplica, logs de acceso a operación sensible por admin.

---

## 2) PDF apartados

### 2.1 Generar PDF oficial

**Request sugerido**

```bash
curl -i "$BASE_URL/api/core?action=apartados&op=pdf&folio=$FOLIO_TEST" \
  -H "cookie: $ADMIN_COOKIE"
```

### 2.2 Actualizar PDF

**Request sugerido**

```bash
curl -i "$BASE_URL/api/core?action=apartados&op=pdf-refresh" \
  -X POST \
  -H 'content-type: application/json' \
  -H "cookie: $ADMIN_COOKIE" \
  --data '{"folio":"'$FOLIO_TEST'"}'
```

### 2.3 Ver PDF persistido

**Request sugerido**

```bash
curl -i "$BASE_URL/api/core?action=apartados&op=detail&folio=$FOLIO_TEST&syncPdf=1" \
  -H "cookie: $ADMIN_COOKIE"
```

**Resultado esperado (2.1–2.3)**

- `pdfUrl` presente y accesible.
- Tras refresh, `updatedAt`/metadatos del PDF cambian.
- En `detail` el PDF aparece persistido (no solo temporal).

**Revisar en Sheets**

- Hoja `apartados`: columnas de PDF (url/id/updatedAt, según esquema actual) actualizadas para el folio.

**Revisar en logs/consola**

- `apartados.pdf_refresh.start/success`.
- Sin `apartados.pdf_refresh.failed`.

---

## 3) Ventas

### 3.1 Sync manual

```bash
curl -i "$BASE_URL/api/ventas/sync" -X POST
```

**Esperado**: `200` con `ok: true` y estado de sync exitoso.

### 3.2 Sync doble simultáneo

```bash
( curl -s "$BASE_URL/api/ventas/sync" -X POST & curl -s "$BASE_URL/api/ventas/sync" -X POST & wait )
```

**Esperado**:

- Una ejecución procesa.
- La otra responde `skipped: true` con `reason: "sync_running"`.

### 3.3 Webhook duplicado

Enviar 2 veces el mismo payload de webhook (mismo `id/order_id/event`).

```bash
curl -i "$BASE_URL/api/tiendanube/webhook" \
  -X POST \
  -H 'content-type: application/json' \
  -H "x-linkedstore-hmac-sha256: $TN_HMAC" \
  --data '{"id":123456,"store_id":111,"event":"order/paid","order_id":987654}'
```

(Repetir exactamente una segunda vez.)

**Esperado**:

- Primera: procesa normal (`processed` o `no_relevant_change`).
- Segunda: deduplicada/ignorada o sin duplicar efectos.

### 3.4 Resumen ventas correcto

```bash
curl -i "$BASE_URL/api/core?action=ventas-resumen" -H "cookie: $ADMIN_COOKIE"
```

**Esperado**: totales consistentes con ventas cargadas tras sync/webhook.

**Revisar en Sheets**

- No filas duplicadas para misma venta/evento.
- Columnas de trazabilidad de sync actualizadas (`last_sync_*` si aplica).

**Revisar en logs/consola**

- `[ventas-sync-manual] start`.
- Eventos de lock/salto por concurrencia.
- `[ventas-webhook]` con resultado claro por evento.

---

## 4) Prendas

### 4.1 Crear prenda normal

```bash
curl -i "$BASE_URL/api/core?action=prendas-create" \
  -X POST \
  -H 'content-type: application/json' \
  -H "cookie: $ADMIN_COOKIE" \
  --data '{"nombre":"Prenda smoke","precio":499,"talla":"M"}'
```

### 4.2 Doble envío mismo código

Enviar dos creates con mismo `codigo` casi simultáneo.

### 4.3 Retry con `idempotencyKey`

```bash
curl -i "$BASE_URL/api/core?action=prendas-create" \
  -X POST \
  -H 'content-type: application/json' \
  -H "cookie: $ADMIN_COOKIE" \
  --data '{"codigo":"PR-777","nombre":"Prenda idem","precio":599,"idempotencyKey":"idem-prenda-777"}'
```

(Repetir exactamente el mismo request.)

### 4.4 Post-check persistencia

```bash
curl -i "$BASE_URL/api/core?action=prendas-list" -H "cookie: $ADMIN_COOKIE"
```

**Esperado (4.1–4.4)**

- Alta normal crea 1 registro.
- Doble envío no crea duplicados no deseados.
- Retry con misma `idempotencyKey` regresa resultado idempotente.
- `prendas-list` contiene el estado final correcto.

**Revisar en Sheets**

- `prendas_admin_activas`: una sola fila por código final esperado.

**Revisar en logs/consola**

- Mensajes tipo `duplicate create prevented`, `code collision detected` o `in-flight` según caso.

---

## 5) Sheets

### 5.1 Crear/editar registros

- Ejecutar un alta real de apartado, prenda o abono (según secciones 4 y 6).
- Editar estado (por ejemplo `apartados op=update_status`).

### 5.2 Error claro si falla escritura

Prueba controlada: enviar payload inválido para forzar validación/fracaso de escritura.

```bash
curl -i "$BASE_URL/api/core?action=apartados&op=create" \
  -X POST \
  -H 'content-type: application/json' \
  -H "cookie: $ADMIN_COOKIE" \
  --data '{}'
```

**Esperado**

- Error explícito y accionable (`message` + `code`).
- No respuestas ambiguas ni silenciosas.

**Revisar en Sheets**

- No filas corruptas/parciales tras error.

**Revisar en logs/consola**

- Stack o mensaje de error con contexto (operación, traceId, motivo).

---

## 6) Apartados / abonos

### 6.1 Crear apartado

```bash
curl -i "$BASE_URL/api/core?action=apartados&op=create" \
  -X POST \
  -H 'content-type: application/json' \
  -H "cookie: $ADMIN_COOKIE" \
  --data '{"cliente":"Smoke QA","telefono":"3312345678","items":[{"sku":"SKU-1","cantidad":1,"precio":300}],"anticipo":100}'
```

### 6.2 Registrar abono normal

```bash
curl -i "$BASE_URL/api/core?action=apartados&op=abono" \
  -X POST \
  -H 'content-type: application/json' \
  -H "cookie: $ADMIN_COOKIE" \
  --data '{"folio":"'$FOLIO_TEST'","monto":50,"operationId":"abono-smoke-1"}'
```

### 6.3 Doble abono mismo `operationId`

Repetir exactamente la llamada anterior.

### 6.4 Abono parcial a vencido mantiene `VENCIDO`

- Preparar folio en estado vencido.
- Registrar abono menor al saldo total.

**Esperado**: estado sigue `VENCIDO`.

### 6.5 Abono total liquida

- Registrar abono por saldo restante completo.

**Esperado**: estado cambia a liquidado (`LIQUIDADO`/equivalente).

### 6.6 Fallo PDF devuelve `PDF_STALE`

- Simular fallo de actualización PDF durante abono (por configuración o forzado en entorno de QA).

**Esperado**:

- Operación de abono responde parcial con `PDF_STALE`.
- El movimiento financiero queda persistido aunque PDF requiera refresh.

**Revisar en Sheets**

- `apartados`: saldo, estado y fechas consistentes.
- `apartados_abonos`: un solo registro por `operationId`.
- `apartados_abonos_ops`: marca de operación idempotente/duplicada según caso.

**Revisar en logs/consola**

- `apartados.abono.start`, `apartados.abono.validated`, `apartados.abono.history_saved`, `apartados.abono.parent_updated`.
- En duplicado: `apartados.abono.duplicated`.
- En fallo PDF: `apartados.abono.pdf_failed` + salida parcial.

---

## Criterio de salida (Go / No-Go)

- **GO**: todos los casos críticos pasan y los “duplicados” quedan idempotentes/sin efectos secundarios.
- **NO-GO**: cualquier 401 inesperado con sesión admin, duplicación de datos en Sheets, inconsistencia de saldos/estados o abonos sin traza.
