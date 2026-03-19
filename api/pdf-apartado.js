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

export default async function handler(req, res) {
  const folio = String(req.query?.folio || req.body?.folio || '').trim();
  logStep('start', { folio });

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
  let browser;
  let stage = 'browser_launch';

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport,
    });
    logStep('browser_launched', { folio });

    stage = 'page_render';
    const page = await browser.newPage();
    await page.emulateMediaType('screen');
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('[data-pdf-ticket="true"]', { timeout: 15000 });
    await page.evaluate(async () => {
      if (document?.fonts?.ready) await document.fonts.ready;
    });
    logStep('html_loaded', { targetUrl });

    stage = 'pdf_generate';
    const pdfBuffer = await page.pdf({
      format: 'letter',
      printBackground: true,
      margin: {
        top: '12mm',
        right: '12mm',
        bottom: '12mm',
        left: '12mm',
      },
    });
    logStep('pdf_generated', { bytes: pdfBuffer.length });

    stage = 'drive_upload';
    const driveResult = await saveRenderedApartadoPdfToDrive({ folio, pdfBuffer });
    if (driveResult?.ok) {
      logStep('drive_uploaded', {
        fileId: driveResult.fileId,
        fileName: driveResult.fileName,
        folderId: driveResult.folderId,
      });
    } else {
      logStep('drive_upload_failed', {
        details: driveResult?.details || driveResult?.error || 'unknown error',
      });
    }

    stage = 'response_send';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${folio}.pdf"`);
    logStep('response_sent', { folio });
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
