import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const folio = searchParams.get('folio');

    if (!folio) {
      return Response.json({ ok: false, message: 'Falta folio' }, { status: 400 });
    }

    const origin = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || new URL(req.url).origin;
    const targetUrl = `${origin}/apartado-pdf/${encodeURIComponent(folio)}`;

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      defaultViewport: chromium.defaultViewport,
      headless: true,
      ignoreHTTPSErrors: true,
    });

    try {
      const page = await browser.newPage();

      await page.goto(targetUrl, {
        waitUntil: 'networkidle0',
        timeout: 45000,
      });

      await page.emulateMediaType('screen');

      await page.waitForSelector('[data-pdf-ticket="true"]', {
        timeout: 15000,
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

      return new Response(Buffer.from(pdf), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename=${folio}.pdf`,
          'Cache-Control': 'no-store',
        },
      });
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('PDF ERROR:', error);

    return Response.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
