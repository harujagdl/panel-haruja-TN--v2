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

function shouldSkipDriveUpload() {
  return String(process.env.APARTADOS_PDF_DISABLE_DRIVE_UPLOAD || '').trim() === '1';
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

async function getExecutablePath() {
  const isProd = process.env.NODE_ENV === 'production';

  // En producción NO forzar rutas manuales.
  if (isProd) {
    return await chromium.executablePath();
  }

  // Solo en local permitir override manual si hace falta.
  const localOverride = String(process.env.CHROME_EXECUTABLE_PATH || '').trim();
  if (localOverride) {
    console.log('pdf:chrome_override_dev', { executablePath: localOverride });
    return localOverride;
  }

  return await chromium.executablePath();
}

async function waitForQrReady(page) {
  await page.waitForFunction(
    () => {
      const flagOk = document?.body?.dataset?.qrReady === '1';
      if (!flagOk) return false;

      const canvas = document.getElementById('qr');
      if (!canvas) return false;

      const hasSize = Number(canvas.width) > 0 && Number(canvas.height) > 0;
      if (!hasSize) return false;

      const ctx = canvas.getContext?.('2d');
      if (!ctx) return false;

      // Revisa varios puntos del canvas para evitar falsos negativos.
      const points = [
        [0, 0],
        [Math.max(0, Math.floor(canvas.width / 2)), Math.max(0, Math.floor(canvas.height / 2))],
        [Math.max(0, canvas.width - 1), Math.max(0, canvas.height - 1)],
      ];

      return points.some(([x, y]) => {
        try {
          const data = ctx.getImageData(x, y, 1, 1)?.data || [];
          return Number(data[3] || 0) > 0;
        } catch {
          return false;
        }
      });
    },
    { timeout: 15000 }
  );
}

export default async function handler(req, res) {
  console.log('pdf:start');

  const folio = String(req.query?.folio || req.body?.folio || '').trim();
  console.log('pdf:folio', { folio });

  if (!folio) {
    return res.status(400).json({ ok: false, message: 'folio es obligatorio.' });
  }

  const baseUrl = getBaseUrl(req);
  if (!baseUrl) {
    return res.status(500).json({ ok: false, message: 'No se pudo resolver APP_URL.' });
  }

  const targetUrl = `${baseUrl}/apartado-pdf/${encodeURIComponent(folio)}`;
  let browser;
  let stage = 'browser_launch';

  try {
    const executablePath = await getExecutablePath();
    console.log('pdf:executable_path_ok');

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none',
        '--single-process',
      ],
      executablePath,
      headless: 'new',
      defaultViewport: chromium.defaultViewport,
      ignoreHTTPSErrors: true,
    });
    console.log('pdf:browser_ok', { folio, targetUrl });

    stage = 'page_render';
    const page = await browser.newPage();
    await page.emulateMediaType('screen');
    console.log('pdf:page_ok_opened');

    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    await page.waitForSelector('[data-pdf-ticket="true"]', { timeout: 15000 });

    await page.evaluate(async () => {
      if (document?.fonts?.ready) {
        await document.fonts.ready;
      }
    });

    console.log('pdf:html_ok', { targetUrl });

    stage = 'qr_wait';
    await waitForQrReady(page);
    console.log('pdf:qr_ready', { folio });

    stage = 'pdf_generate';
    const pdfBuffer = await page.pdf({
      format: 'letter',
      printBackground: true,
      margin: {
        top: '8mm',
        right: '8mm',
        bottom: '8mm',
        left: '8mm',
      },
      // Evita pelearse con @page si el HTML ya trae estilos de impresión.
      preferCSSPageSize: false,
    });

    console.log('pdf:buffer_ok', { bytes: pdfBuffer.length });

    if (shouldSkipDriveUpload()) {
      console.log('pdf:drive_skip');
    } else {
      stage = 'drive_upload';
      try {
        const driveResult = await saveRenderedApartadoPdfToDrive({ folio, pdfBuffer });

        if (driveResult?.ok) {
          console.log('pdf:drive_ok', {
            fileId: driveResult.fileId,
            fileName: driveResult.fileName,
          });
        } else {
          console.error('pdf:drive_error', {
            details: driveResult?.details || driveResult?.error || 'unknown error',
          });
        }
      } catch (driveError) {
        console.error('pdf:drive_error', {
          message: driveError?.message || 'unknown error',
        });
      }
    }

    stage = 'response_send';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${folio}.pdf"`);
    res.status(200).send(pdfBuffer);
    console.log('pdf:response_ok', { folio });
    return;
  } catch (error) {
    const payload = toErrorPayload(error, stage);
    console.error('pdf:error', payload);
    return res.status(500).json(payload);
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
