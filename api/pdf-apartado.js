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

function logStep(step, context = {}) {
  console.log(`[pdf-apartado] ${step}`, context);
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

async function launchBrowser() {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || (await chromium.executablePath());
  if (!executablePath) {
    throw new Error('No se pudo resolver executablePath de Chromium para Vercel.');
  }

  return puppeteer.launch({
    args: chromium.args,
    executablePath,
    headless: chromium.headless,
    defaultViewport: chromium.defaultViewport,
    ignoreHTTPSErrors: true,
  });
}

export default async function handler(req, res) {
  const folio = String(req.query?.folio || req.body?.folio || '').trim();
  logStep('pdf:start', { folio });

  if (!folio) {
    logStep('invalid_request', { reason: 'folio is required' });
    return res.status(400).json({ ok: false, message: 'folio es obligatorio.' });
  }

  const baseUrl = getBaseUrl(req);
  if (!baseUrl) {
    logStep('invalid_request', { reason: 'baseUrl unavailable' });
    return res.status(500).json({ ok: false, message: 'No se pudo resolver APP_URL.' });
  }

  const targetUrl = `${baseUrl}/apartado-pdf/${encodeURIComponent(folio)}`;
  logStep('pdf:folio', { folio, targetUrl });

  let browser;
  let stage = 'browser_launch';

  try {
    browser = await launchBrowser();
    logStep('pdf:browser_ok', { folio });

    stage = 'html_render';
    const page = await browser.newPage();
    await page.emulateMediaType('print');
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('[data-pdf-ticket="true"]', { timeout: 15000 });
    await page.evaluate(async () => {
      if (document?.fonts?.ready) await document.fonts.ready;
    });
    logStep('pdf:html_ok', { folio });

    stage = 'pdf_generate';
    const pdfBuffer = await page.pdf({
      format: 'letter',
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: '10mm',
        right: '10mm',
        bottom: '10mm',
        left: '10mm',
      },
    });
    logStep('pdf:buffer_ok', { bytes: pdfBuffer.length });

    stage = 'drive_upload';
    logStep('drive_upload_start', { folio });
    const driveResult = await saveRenderedApartadoPdfToDrive({ folio, pdfBuffer });
    if (driveResult?.ok) {
      logStep('drive_upload_success', {
        fileId: driveResult.fileId,
        fileName: driveResult.fileName,
        folderId: driveResult.folderId,
      });
      logStep('drive_file_id', { fileId: driveResult.fileId });
      logStep('pdf:drive_ok', { fileId: driveResult.fileId });
    } else {
      logStep('drive_upload_failed', {
        details: driveResult?.details || driveResult?.error || 'unknown error',
      });
    }

    stage = 'response_send';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Ticket-${folio}.pdf"`);
    logStep('pdf:response_ok', { folio });
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    const payload = toErrorPayload(error, stage);
    logStep('error', payload);
    return res.status(500).json(payload);
  } finally {
    if (browser) {
      await browser.close();
      logStep('browser_closed', { folio });
    }
  }
}
