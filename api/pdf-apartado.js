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
  const configured = String(process.env.CHROME_EXECUTABLE_PATH || '').trim();
  if (configured) return configured;
  return chromium.executablePath();
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

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport,
      ignoreHTTPSErrors: true,
    });
    console.log('pdf:browser_ok', { folio, targetUrl });

    stage = 'page_render';
    const page = await browser.newPage();
    await page.emulateMediaType('screen');
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('[data-pdf-ticket="true"]', { timeout: 15000 });
    await page.evaluate(async () => {
      if (document?.fonts?.ready) await document.fonts.ready;
    });
    console.log('pdf:html_ok', { targetUrl });

    stage = 'pdf_generate';
    const pdfBuffer = await page.pdf({
      format: 'letter',
      printBackground: true,
      margin: {
        top: '10mm',
        right: '10mm',
        bottom: '10mm',
        left: '10mm',
      },
      preferCSSPageSize: true,
    });
    console.log('pdf:buffer_ok', { bytes: pdfBuffer.length });

    if (shouldSkipDriveUpload()) {
      console.log('pdf:drive_skip');
    } else {
      stage = 'drive_upload';
      console.log('pdf:drive_start', { folio });
      const driveResult = await saveRenderedApartadoPdfToDrive({ folio, pdfBuffer });

      if (driveResult?.ok) {
        console.log('pdf:drive_ok', { fileName: driveResult.fileName });
        console.log('pdf:drive_file_id', { fileId: driveResult.fileId });
      } else {
        console.error('pdf:drive_error', {
          details: driveResult?.details || driveResult?.error || 'unknown error',
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
      await browser.close();
    }
  }
}
