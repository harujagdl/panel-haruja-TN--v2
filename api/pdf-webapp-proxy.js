export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  try {
    const webAppUrl = String(process.env.HARUJA_APARTADOS_PDF_WEBAPP_URL || '').trim();

    if (!webAppUrl) {
      return res.status(500).json({
        ok: false,
        message: 'Falta HARUJA_APARTADOS_PDF_WEBAPP_URL en variables de entorno.',
      });
    }

    const response = await fetch(webAppUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify(req.body || {}),
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({
        ok: false,
        message: 'Respuesta no válida del Apps Script.',
        raw: text.slice(0, 500),
      });
    }

    return res.status(response.ok ? 200 : 502).json(data);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || 'Error inesperado en proxy de PDF.',
    });
  }
}
