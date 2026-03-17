import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  try {

    const { searchParams } = new URL(req.url);
    const folio = searchParams.get("folio");

    if (!folio) {
      return new Response("Falta folio", { status: 400 });
    }

    const url = `${process.env.NEXT_PUBLIC_APP_URL}/apartado-pdf/${folio}`;

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();

    await page.goto(url, {
      waitUntil: "networkidle0",
    });

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

    await browser.close();

    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename=${folio}.pdf`,
      },
    });

  } catch (err) {

    console.error("PDF ERROR:", err);

    return new Response(
      `Error generando PDF: ${err.message}`,
      { status: 500 }
    );

  }
}
