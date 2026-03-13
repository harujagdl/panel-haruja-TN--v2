export function sendSuccess(res, data = {}) {
  return res.status(200).json({ ok: true, ...data });
}

export function sendError(res, error, fallbackMessage = 'Error en loyalty API') {
  const message = error?.message || fallbackMessage;
  const status = /no encontrado/i.test(message) ? 404 : /insuficiente|obligatorio|debe/i.test(message) ? 400 : 500;
  return res.status(status).json({ ok: false, error: message });
}

export function allowMethods(req, res, methods = []) {
  if (!methods.includes(req.method)) {
    res.setHeader('Allow', methods.join(', '));
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return false;
  }
  return true;
}
