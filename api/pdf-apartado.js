import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { saveRenderedApartadoPdfToDrive } from '../lib/apartados/pdf-sync.js';

function getBaseUrl(reqLike = {}) {
  const configured = String(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (configured) return configured;

  const headers = reqLike.headers || {};
  const host = headers['x-forwarded-host'] || headers.host || '';
  const proto = headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host}` : '';
}

function toErrorPayload(error, stage) {
  return {
    ok: false,
    stage,
    message: error?.message || 'No se pudo generar el PDF oficial.',
    stack: String(error?.stack || '')
      .split('\n')
      .slice(0, 3)
      .join(' | '),
  };
}

function shouldJsonResponse(req) {
  const format = String(req.query?.format || req.body?.format || '').trim().toLowerCase();
  return format === 'json';
}

async function getExecutablePath() {
  const localOverride = String(process.env.CHROME_EXECUTABLE_PATH || '').trim();
  if (localOverride) {
    console.log('pdf:chrome_override', { executablePath: localOverride });
    return localOverride;
  }
  return chromium.executablePath();
}

async function waitForQrReady(page) {
  await page.waitForFunction(
    () => {
      const body = document?.body;
      const datasetReady = body?.dataset?.qrReady === '1';
      const globalReady = window.__qrReady === true;
      if (!datasetReady && !globalReady) return false;

      const canvas = document.getElementById('qr');
      if (!canvas) return false;
      const width = Number(canvas.width || 0);
      const height = Number(canvas.height || 0);
      if (width < 20 || height < 20) return false;

      const ctx = canvas.getContext?.('2d');
      if (!ctx) return false;

      try {
        const center = ctx.getImageData(Math.floor(width / 2), Math.floor(height / 2), 1, 1)?.data || [];
        return Number(center[3] || 0) > 0;
      } catch (_) {
        return false;
      }
    },
    { timeout: 20000 },
  );
}

async function buildOfficialPdf({ folio, req }) {
  const baseUrl = getBaseUrl(req);
  if (!baseUrl) {
    throw new Error('No se pudo resolver APP_URL.');
  }

  const targetUrl = `${baseUrl}/apartado-pdf/${encodeURIComponent(folio)}`;
  let browser;
  let stage = 'browser_launch';

  try {
    const executablePath = await getExecutablePath();
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      executablePath,
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport,
      ignoreHTTPSErrors: true,
    });
    console.log('pdf:browser_ok', { folio });

    stage = 'html_render';
    const page = await browser.newPage();
    await page.emulateMediaType('print');
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    await page.waitForSelector('[data-pdf-ticket="true"]', { timeout: 15000 });
    await page.evaluate(async () => {
      if (document?.fonts?.ready) await document.fonts.ready;
    });
    console.log('pdf:html_ok', { folio, targetUrl });

    stage = 'qr_wait';
    await waitForQrReady(page);
    console.log('pdf:qr_ready', { folio });

    stage = 'pdf_generate';
    const pdfBuffer = await page.pdf({
      format: 'letter',
      printBackground: true,
      margin: {
        top: '0',
        right: '0',
        bottom: '0',
        left: '0',
      },
      preferCSSPageSize: true,
    });
    console.log('pdf:buffer_ok', { folio, bytes: pdfBuffer.length });

    return { pdfBuffer, stage: 'drive_upload' };
  } catch (error) {
    throw Object.assign(error, { _stage: stage });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('pdf:browser_close_error', {
          message: closeError?.message || 'unknown error',
        });
      }
    }
  }
}

export default async function handler(req, res) {
  console.log('pdf:start');
  const folio = String(req.query?.folio || req.body?.folio || '').trim();

  if (!folio) {
    return res.status(400).json({ ok: false, message: 'folio es obligatorio.' });
  }

  const wantsJson = shouldJsonResponse(req);
  let stage = 'browser_launch';

  try {
    const renderResult = await buildOfficialPdf({ folio, req });
    stage = renderResult.stage || 'drive_upload';

    const driveResult = await saveRenderedApartadoPdfToDrive({ folio, pdfBuffer: renderResult.pdfBuffer });
    if (!driveResult?.ok || (!driveResult?.pdfUrl && !driveResult?.fileId)) {
      throw new Error(driveResult?.details || driveResult?.error || 'No se pudo guardar el PDF en Drive.');
    }

    const payload = {
      ok: true,
      folio,
      pdfUrl: String(driveResult.pdfUrl || '').trim(),
      fileId: String(driveResult.fileId || '').trim(),
      updatedAt: String(driveResult.updatedAt || new Date().toISOString()).trim(),
      fileName: String(driveResult.fileName || '').trim(),
      replaced: Boolean(driveResult.replaced),
    };

    console.log('pdf:drive_ok', { folio, fileId: payload.fileId, pdfUrl: payload.pdfUrl });

    if (wantsJson) {
      console.log('pdf:response_ok', { folio, mode: 'json' });
      return res.status(200).json(payload);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${folio}.pdf"`);
    res.setHeader('X-Apartado-Pdf-Url', payload.pdfUrl);
    res.setHeader('X-Apartado-Pdf-File-Id', payload.fileId);
    res.status(200).send(renderResult.pdfBuffer);
    console.log('pdf:response_ok', { folio, mode: 'binary' });
    return;
  } catch (error) {
    stage = error?._stage || stage;
    const payload = toErrorPayload(error, stage);
    console.error('pdf:error', payload);
    return res.status(500).json(payload);
  }
}
