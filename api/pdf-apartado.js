const { google } = require('googleapis');

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

async function createBrowser() {
  const chromium = (await import('@sparticuz/chromium')).default;
  const puppeteerModule = await import('puppeteer-core');
  const puppeteer = puppeteerModule.default || puppeteerModule;

  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1400, height: 2000, deviceScaleFactor: 2 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

function logStep(step, context = {}) {
  console.log(`[pdf-apartado] ${step}`, context);
}

export default async function handler(req, res) {
  const folio = String(req.query?.folio || req.body?.folio || '').trim();
  logStep('request.received', { folio });

  if (!folio) {
    logStep('request.invalid', { reason: 'folio is required' });
    return res.status(400).json({ ok: false, message: 'folio es obligatorio.' });
  }

  const baseUrl = getBaseUrl(req);
  if (!baseUrl) {
    logStep('request.invalid', { reason: 'baseUrl unavailable' });
    return res.status(500).json({ ok: false, message: 'No se pudo resolver APP_URL.' });
  }

  const targetUrl = `${baseUrl}/apartado-pdf/${encodeURIComponent(folio)}`;
  logStep('target_url.resolved', { targetUrl });

  let browser;

  try {
    browser = await createBrowser();
    logStep('browser.launch.ok');

    const page = await browser.newPage();
    await page.emulateMediaType('screen');
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    logStep('page.goto.ok');

    await page.waitForSelector('[data-pdf-ticket="true"]', { timeout: 15000 });
    logStep('page.selector.ok', { selector: '[data-pdf-ticket="true"]' });

    await page.evaluate(async () => {
      if (document?.fonts?.ready) {
        await document.fonts.ready;
      }
    });

    const pdf = await page.pdf({
      format: 'letter',
      printBackground: true,
      margin: {
        top: '12mm',
        right: '12mm',
        bottom: '12mm',
        left: '12mm',
      },
    });
    logStep('pdf.generated', { bytes: pdf.length });

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const drive = google.drive({
      version: 'v3',
      auth,
    });

    const FOLDER_ID = '1y3l0r-4XnSsicnuSeVaATSh3rC89j-If';

    const fileMetadata = {
      name: `Apartado-${folio}.pdf`,
      parents: [FOLDER_ID],
    };

    const media = {
      mimeType: 'application/pdf',
      body: Buffer.from(pdf),
    };

    await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id',
    });
    logStep('drive.upload.ok', { fileName: fileMetadata.name });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=${folio}.pdf`);
    return res.status(200).send(Buffer.from(pdf));
  } catch (error) {
    logStep('error.final', { message: error?.message || 'unknown error' });
    return res.status(500).json({ ok: false, message: error?.message || 'No se pudo generar el PDF oficial.' });
  } finally {
    if (browser) {
      await browser.close();
      logStep('browser.closed');
    }
  }
}
