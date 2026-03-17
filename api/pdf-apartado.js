function getBaseUrl(reqLike = {}) {
  const configured = String(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const headers = reqLike.headers || {};
  const host = headers['x-forwarded-host'] || headers.host || '';
  const proto = headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host}` : '';
}

async function createBrowser() {
  const chromium = (await import('@sparticuz/chromium')).default;
  const puppeteer = await import('puppeteer-core');

  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1400, height: 2000, deviceScaleFactor: 2 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

export default async function handler(req, res) {
  const folio = String(req.query?.folio || req.body?.folio || '').trim();
  if (!folio) return res.status(400).json({ ok: false, message: 'folio es obligatorio.' });

  const baseUrl = getBaseUrl(req);
  if (!baseUrl) return res.status(500).json({ ok: false, message: 'No se pudo resolver APP_URL.' });

  const targetUrl = `${baseUrl}/apartado-pdf/${encodeURIComponent(folio)}`;
  let browser;

  try {
    browser = await createBrowser();
    const page = await browser.newPage();
    await page.emulateMediaType('screen');
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('[data-pdf-ticket="true"]', { timeout: 15000 });
    await page.evaluate(async () => {
      if (document?.fonts?.ready) {
        await document.fonts.ready;
      }
    });

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

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="apartado-${folio}.pdf"`);
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || 'No se pudo generar el PDF oficial.' });
  } finally {
    if (browser) await browser.close();
  }
}
