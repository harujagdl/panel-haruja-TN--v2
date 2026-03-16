# Flujo de PDF oficial de apartados con Google Apps Script

## Objetivo

Generar y guardar el PDF oficial desde una **cuenta humana de Google** (Apps Script Web App), evitando la cuota de Drive de Service Account en Vercel.

## Carpeta oficial de Drive

- `1y3l0r-4XnSsicnuSeVaATSh3rC89j-If`
- Nombre obligatorio: `${folio}.pdf`
- Regla: debe existir **solo 1 PDF vigente por folio** (si existe, se manda a trash y se reemplaza).

## Contrato del Web App

Request `POST` JSON:

```json
{
  "action": "generar_pdf_apartado",
  "folio": "HARUJA26-002"
}
```

Éxito:

```json
{
  "ok": true,
  "folio": "HARUJA26-002",
  "fileId": "...",
  "folderId": "1y3l0r-4XnSsicnuSeVaATSh3rC89j-If",
  "pdfUrl": "https://drive.google.com/file/d/FILE_ID/view"
}
```

Error:

```json
{
  "ok": false,
  "message": "No se pudo generar el PDF",
  "details": "mensaje real"
}
```

## Implementación de Apps Script

- Script de referencia: `docs/apps-script/apartados-pdf-webapp.gs`
- Entrada principal: `doPost(e)`
- Pasos:
  1. Validar `action` y `folio`.
  2. Buscar folio en hojas `apartados` + `apartados_items`.
  3. Renderizar ticket HTML carta.
  4. Generar blob PDF.
  5. Eliminar `${folio}.pdf` previo dentro de la carpeta oficial.
  6. Crear nuevo `${folio}.pdf`.
  7. Actualizar columnas `PdfFileId`, `PdfUrl`, `PdfUpdatedAt`, `HasOfficialPdf`.
  8. Responder JSON con `ok`, `fileId`, `pdfUrl`.

## Frontend (historial)

El botón **Generar PDF oficial** ya usa Apps Script directo (no `/api/core` para regeneración manual).

Configurar URL del Web App en el navegador con una de estas opciones:

1. Global en runtime:

```js
window.HARUJA_APARTADOS_PDF_WEBAPP_URL = 'https://script.google.com/macros/s/.../exec';
```

2. LocalStorage:

```js
localStorage.setItem('HARUJA_APARTADOS_PDF_WEBAPP_URL', 'https://script.google.com/macros/s/.../exec');
```

Sin esa URL, el botón mostrará error de configuración.
