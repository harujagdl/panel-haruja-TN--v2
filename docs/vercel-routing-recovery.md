# Vercel routing recovery (panel-haruja-tn-v2)

## Fuente de verdad de rutas públicas

Producción debe resolver las siguientes rutas hacia estos archivos reales:

- `/` -> `/index.html`
- `/index.html` -> `/index.html`
- `/ventas` -> `/ventas/index.html`
- `/ventas.html` (legacy) -> `/ventas/index.html`
- `/apartados` -> `/apartados/index.html`
- `/apartados-historial` -> `/apartados-historial/index.html`
- `/ticket` -> `/ticket/index.html`
- `/ticket/:folio` -> `/ticket/index.html`
- `/apartado/:folio` -> `/apartados/index.html`
- `/lealtad` -> `/app/lealtad/index.html`
- `/lealtad/:path+` -> `/app/lealtad/:path+`
- `/tarjeta-lealtad` -> `/app/tarjeta-lealtad.html`
- `/tarjeta-lealtad.html` (legacy) -> `/app/tarjeta-lealtad.html`

## Duplicidades y decisión operativa

- `apartados/index.html` **es producción** para `/apartados`.
- `app/apartados/index.html` queda como **legacy/respaldo** y no participa en rewrites.
- `apartados-historial/index.html` **es producción** para `/apartados-historial`.
- `app/apartados-historial/index.html` queda como **legacy/respaldo** y no participa en rewrites.
- `shared/*` y `app/shared/*` coexisten por consumo desde distintas entradas; no hay rewrite cruzado entre ambas carpetas.
- `public/assets/*` es la referencia canónica para logos públicos.
- `app/assets/*` se mantiene para módulos bajo `/app/*`.

## Panel principal y hash routing

`/index.html` contiene el shell del panel y usa hash routing interno (`#/panel`, `#/registro`, `#/codigos`, `#/meta-vs-venta`).

## Backups de app

Archivos `app/index_backup_*` son respaldos y **no** participan en producción ni en rewrites de Vercel.

## Configuración recomendada para proyecto nuevo en Vercel

- Framework Preset: `Other`
- Build Command: vacío
- Install Command: vacío
- Output Directory: vacío
- Development Command: vacío
- Root Directory: vacío

No usar override de Output Directory y no usar Root Directory personalizado.
