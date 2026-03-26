# panel-haruja-TN--v2

## Estado de arquitectura (fase estabilización v2)

### Ya desacoplado de Firebase Hosting legacy
- Se eliminó la dependencia de scripts `//__/firebase/*` y `shared/firebase-init.js` en `index.html`.
- La configuración de Firebase se centraliza en el bloque moderno `script type="module"`.
- El módulo de **Base de datos códigos HarujaGdl** carga desde `GET /api/core?action=prendas-list` (Google Sheets API adapter).

### Sigue usando Firebase (por compatibilidad)
- Autenticación de admin con Google.
- Firestore para diccionarios del módulo Registro:
  - `diccionario_tipos`
  - `diccionario_proveedores`
  - `diccionario_colores`
  - `diccionario_tallas`

> TODO v2 siguiente fase: migrar diccionarios + registro a Google Sheets API.

### Nota para deploy en Vercel
Si el login admin con Google falla, verificar dominios autorizados:
`Firebase Console > Authentication > Settings > Authorized domains`.


### Variables de entorno (admin)
- `ADMIN_SESSION_SECRET=pon_un_secreto_largo_de_al_menos_32_caracteres`
