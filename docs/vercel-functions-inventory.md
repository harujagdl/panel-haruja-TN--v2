# Inventario y consolidación de Vercel Functions (Hobby)

## Estado inicial detectado en `/api`

| Archivo | Propósito | Activo al iniciar | Fusión / destino |
|---|---|---:|---|
| `api/core.js` | Router principal de ventas, catálogos, prendas y utilidades Tiendanube. | Sí | Se mantiene como `/api/core.js`. |
| `api/apartados.js` | Endpoints de apartados (folio, listado, detalle, abonos, cancelación). | Sí | Se fusiona en `action=apartados` dentro de `/api/core.js` y acciones pesadas en `/api/sheets.js`. |
| `api/documentos.js` | Operaciones de ticket/PDF (status, preview, print, refresh). | Sí | Se fusiona en `/api/sheets.js` (acciones `ticket-*`). |
| `api/loyalty.js` | API en memoria para loyalty (no crítica para flujo principal de ventas). | No (sin referencias activas del frontend actual) | Se elimina por límite de Functions. |
| `api/tiendanube/start.js` | Inicio OAuth Tiendanube. | Sí | Se fusiona en `/api/tiendanube.js?action=connect`. |
| `api/tiendanube/callback.js` | Callback OAuth Tiendanube. | Sí | Se fusiona en `/api/tiendanube.js` (callback por `code/state`). |
| `api/tiendanube/sync.js` | Sync manual de órdenes Tiendanube. | Sí | Se fusiona en `/api/tiendanube.js?action=sync`. |
| `api/tiendanube/webhook.js` | Recepción y procesamiento de webhook Tiendanube. | Sí | Se mueve a `/api/webhook.js`. |
| `api/tiendanube/webhook-health.js` | Health-check de webhook. | Parcial / auxiliar | Se reemplaza por `action=status` en `/api/tiendanube.js`. |
| `api/tendanube/webhook.js` | Variante legacy/duplicada (typo de carpeta). | No (huérfano) | Se elimina. |

## Estado final en `/api` (4 Functions)

1. `api/core.js`
2. `api/tiendanube.js`
3. `api/webhook.js`
4. `api/sheets.js`

## Mapeo de acciones objetivo

### `/api/core.js`
- `action=ventas-resumen`
- `action=ventas-detalle`
- `action=ventas-webhook-status`
- `action=prendas`
- `action=prendas-admin`
- `action=catalogos`
- `action=apartados`
- `action=detalle`
- `action=resumen`

### `/api/tiendanube.js`
- `action=sync`
- `action=status`
- `action=connect`
- `action=import-order`

### `/api/webhook.js`
- Recepción de webhooks Tiendanube (POST).

### `/api/sheets.js`
- Operaciones de Google Sheets/PDF/export pesado (`apartados-*`, `ticket-*`).
