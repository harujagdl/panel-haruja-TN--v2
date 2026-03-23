import { getLatestWebhookEvent } from '../lib/ventas/dedupeWebhookEvent.js';
import {
  archivePrenda,
  assignVentaSeller,
  createPrenda,
  deletePrenda,
  generarCodigoPrenda,
  getCatalogos,
  getMetaVsVentaData,
  getVentasComisiones,
  getVentasConfig,
  getVentasDetalle,
  getVentasResumen,
  getVentasSinAsignar,
  importCorrections,
  listArchivedPrendas,
  listPrendas,
  rebuildVentasResumen,
  restorePrenda,
  saveVentasConfig,
  registerTiendanubeWebhooks,
  updateVentasComisiones,
} from '../lib/api/core.js';
import {
  addAbono,
  cancelApartado,
  createApartado,
  getApartadoDetail,
  getHistorialApartado,
  getNextFolio,
  getApartadosMissingPdf,
  listApartados,
  regenerateApartadoPdf,
  searchApartados,
  updateApartadoStatus,
} from '../lib/api/apartados.js';
import { runApartadoPdfDriveWriteTest } from '../lib/apartados/pdf-sync.js';

const sendOk = (res, data) => res.status(200).json({ ok: true, data });
const sendErr = (res, status, message, error) =>
  res.status(status).json({
    ok: false,
    message,
    ...(error ? { error: String(error?.message || error) } : {}),
  });

function getBaseUrl(reqLike = {}) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;

  const headers = reqLike.headers || {};
  const host = headers['x-forwarded-host'] || headers.host || '';
  const proto = headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host}` : '';
}

async function proxyApartadoPdfWebApp(req, res) {
  console.log('pdf_proxy:start');

  const webAppUrl = String(process.env.HARUJA_APARTADOS_PDF_WEBAPP_URL || '').trim();
  if (!webAppUrl) {
    console.error('pdf_proxy:missing_env');
    return res.status(500).json({
      ok: false,
      message: 'Falta HARUJA_APARTADOS_PDF_WEBAPP_URL en variables de entorno.',
    });
  }

  try {
    const response = await fetch(webAppUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify(req.body || {}),
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error('pdf_proxy:apps_script_invalid_json', {
        message: parseError?.message,
        raw: text?.slice?.(0, 400),
      });
      return res.status(502).json({
        ok: false,
        message: 'Respuesta no válida del Apps Script.',
        raw: String(text || '').slice(0, 400),
      });
    }

    if (!response.ok || !data?.ok) {
      console.error('pdf_proxy:error', {
        status: response.status,
        message: data?.message || data?.details || data?.error || `HTTP ${response.status}`,
      });
      return res.status(502).json({
        ok: false,
        message: data?.message || data?.details || data?.error || 'No se pudo procesar el PDF con Apps Script.',
        ...(data?.fileId ? { fileId: data.fileId } : {}),
        ...(data?.pdfUrl ? { pdfUrl: data.pdfUrl } : {}),
      });
    }

    console.log('pdf_proxy:apps_script_ok', {
      fileId: data?.fileId || '',
      pdfUrl: data?.pdfUrl || '',
    });

    return res.status(200).json(data);
  } catch (error) {
    console.error('pdf_proxy:error', {
      message: error?.message,
      stack: error?.stack,
    });
    return res.status(500).json({
      ok: false,
      message: error?.message || 'Error inesperado en proxy de PDF.',
    });
  }
}

async function handlePrendas(req, res) {
  const op = String(req.query?.op || req.body?.op || req.query?.mode || '').trim();

  if (req.method === 'GET' && (!op || op === 'list')) return sendOk(res, await listPrendas());
  if (req.method === 'GET' && op === 'archived') return sendOk(res, await listArchivedPrendas());
  if (req.method === 'POST' && op === 'create') return sendOk(res, await createPrenda(req.body || {}));

  if (req.method === 'POST' && op === 'delete') {
    const result = await deletePrenda(req.body || {});
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'archive') {
    const result = await archivePrenda(req.body || {});
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'restore') {
    const result = await restorePrenda(req.body || {});
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  return sendErr(res, 400, 'Operación inválida para action=prendas.');
}

async function handleApartados(req, res) {
  const op = String(req.query?.op || req.body?.op || '').trim();
  const folio = String(req.query?.folio || req.body?.folio || '').trim();
  const action = String(req.query?.action || '').trim();

  if (req.method === 'GET' && (!op || op === 'list')) return sendOk(res, await listApartados(req.query || {}));
  if (req.method === 'GET' && op === 'next') return sendOk(res, await getNextFolio(req.query?.fecha || req.body?.fecha || ''));
  if (req.method === 'GET' && op === 'search') return sendOk(res, await searchApartados(req.query || {}));

  if (req.method === 'GET' && op === 'missing-pdf') {
    const result = await getApartadosMissingPdf(folio);
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'GET' && op === 'detail') {
    if (!folio) return sendErr(res, 400, 'folio es obligatorio.');
    const result = await getApartadoDetail(folio);
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'GET' && op === 'historial') {
    if (!folio) return sendErr(res, 400, 'folio es obligatorio.');
    const result = await getHistorialApartado(folio);
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'create') return sendOk(res, await createApartado(req.body || {}));
  if (req.method === 'POST' && op === 'abono') return sendOk(res, await addAbono(req.body || {}));

  if (req.method === 'POST' && op === 'update-status') {
    const result = await updateApartadoStatus(req.body || {});
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  // ✅ Proxy real al Apps Script para evitar CORS desde navegador
  if (req.method === 'POST' && op === 'pdf-webapp-proxy') {
    return proxyApartadoPdfWebApp(req, res);
  }

  // ✅ Mantener este flujo por compatibilidad si todavía lo usas en otro lado
  if (req.method === 'POST' && op === 'pdf-refresh') {
    if (!folio) return sendErr(res, 400, 'folio es obligatorio.');
    try {
      const result = await regenerateApartadoPdf(folio, {
        ...(req.body || {}),
      });

      if (result?.status) {
        return res.status(result.status).json(
          result.body || { ok: false, message: 'No se pudo generar el PDF oficial.' }
        );
      }

      return res.status(200).json(result);
    } catch (err) {
      console.error('PDF OFICIAL ERROR', {
        point: 'handleApartados:pdf-refresh:webapp',
        action,
        folio,
        message: err?.message,
        stack: err?.stack,
      });

      return res.status(500).json({
        ok: false,
        message: err?.message || 'Error interno al generar PDF oficial',
      });
    }
  }

  if (req.method === 'POST' && op === 'pdf-drive-test') {
    const result = await runApartadoPdfDriveWriteTest();
    if (!result?.ok) return sendErr(res, 502, result?.error || 'No se pudo guardar el PDF en Drive.');
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'cancel') {
    const result = await cancelApartado(req.body || {});
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  return sendErr(res, 400, 'Operación inválida para action=apartados.');
}

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim();
  if (!action) return sendErr(res, 400, 'action es obligatorio.');

  try {
    if (action === 'ventas-resumen' || action === 'resumen') return sendOk(res, await getVentasResumen(req.query?.month));
    if (action === 'ventas-detalle' || action === 'detalle') return sendOk(res, await getVentasDetalle(req.query?.month, req.query?.q || req.query?.search));
    if (action === 'ventas-webhook-status') return sendOk(res, await getLatestWebhookEvent());
    if (action === 'catalogos') return sendOk(res, await getCatalogos());

    if (action === 'diccionario') {
      const data = await getCatalogos();
      return res.status(200).json({ ok: true, ...data });
    }

    if (action === 'prendas-list') return sendOk(res, await listPrendas());
    if (action === 'prendas-generar-codigo') return sendOk(res, await generarCodigoPrenda(req.body || {}));
    if (action === 'prendas-create') return sendOk(res, await createPrenda(req.body || {}));

    if (action === 'prendas-delete') {
      const result = await deletePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (action === 'prendas-archive') {
      const result = await archivePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (action === 'prendas-archived-list') return sendOk(res, await listArchivedPrendas());

    if (action === 'prendas-restore') {
      const result = await restorePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (action === 'prendas-import-corrections') return sendOk(res, await importCorrections(req.body || {}));

    if (action === 'prendas') return await handlePrendas(req, res);

    if (action === 'prendas-admin') {
      if (req.method === 'GET') return sendOk(res, await listArchivedPrendas());
      return sendOk(res, await importCorrections(req.body || {}));
    }

    if (action === 'apartados') return await handleApartados(req, res);

    if (action === 'ventas-comisiones') {
      if (req.method === 'GET') return sendOk(res, await getVentasComisiones(req.query || {}, req));
      if (req.method === 'POST') return sendOk(res, await updateVentasComisiones(req.body || {}, req));
    }

    if (action === 'meta-vs-venta') {
      const payload = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      return sendOk(res, await getMetaVsVentaData(payload));
    }

    if (action === 'ventas-config') return sendOk(res, await getVentasConfig());
    if (action === 'ventas-config-save') return sendOk(res, await saveVentasConfig(req.body || {}));
    if (action === 'ventas-sin-asignar') return sendOk(res, await getVentasSinAsignar(req.query?.month));
    if (action === 'assign-seller' || action === 'venta-asignar-vendedora') return sendOk(res, await assignVentaSeller(req.body || {}));
    if (action === 'ventas-rebuild') return sendOk(res, await rebuildVentasResumen(req.body?.month || req.query?.month));
    if (action === 'tiendanube-webhooks-register') return sendOk(res, await registerTiendanubeWebhooks(getBaseUrl(req)));

    return sendErr(res, 400, 'Acción inválida para /api/core.');
  } catch (error) {
    return sendErr(res, 400, error?.message || 'Error en /api/core.', error);
  }
}
