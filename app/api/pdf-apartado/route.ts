import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export const runtime = "nodejs";

function getBaseUrl(req: Request) {
  const configured = String(process.env.APP_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;

  const forwardedHost = req.headers.get("x-forwarded-host");
  const host = forwardedHost || req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return host ? `${proto}://${host}` : "";
}

export async function GET(req: Request) {
  let browser;

  try {
    const { searchParams } = new URL(req.url);
    const folio = String(searchParams.get("folio") || "").trim();

    if (!folio) {
      return new Response("Falta folio", { status: 400 });
    }

    const baseUrl = getBaseUrl(req);
    if (!baseUrl) {
      return new Response("No se pudo resolver APP_URL", { status: 500 });
    }

    const url = `${baseUrl}/apartado-pdf/${encodeURIComponent(folio)}`;

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      defaultViewport: { width: 1400, height: 2000, deviceScaleFactor: 2 },
    });

    const page = await browser.newPage();

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 45000,
    });

    await page.waitForSelector('[data-pdf-ticket="true"]', { timeout: 15000 });
    await page.emulateMediaType("screen");

    const pdf = await page.pdf({
      format: "letter",
      printBackground: true,
      margin: {
        top: "12mm",
        right: "12mm",
        bottom: "12mm",
        left: "12mm",
      },
    });

    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename=apartado-${folio}.pdf`,
      },
    });
  } catch (err) {
    console.error(err);
    return new Response("Error generando PDF", { status: 500 });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
