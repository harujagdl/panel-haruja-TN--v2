import { syncVentasFromTiendanube } from '../../lib/api/core.js';
import {
  acquireVentasSyncLock,
  releaseVentasSyncLock,
  writeVentasSyncState,
} from '../../lib/ventas/syncState.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  const lock = await acquireVentasSyncLock();
  if (!lock.acquired) {
    return res.status(200).json({ ok: true, skipped: true, message: 'sync_en_curso' });
  }

  try {
    const data = await syncVentasFromTiendanube();
    const now = new Date().toISOString();
    await writeVentasSyncState({
      mode: 'automatico',
      last_sync_at: now,
      last_sync_result: 'ok',
      last_sync_message: 'sincronizacion manual ejecutada',
      last_created_at_max: now,
      last_updated_at_max: now,
    });
    return res.status(200).json({ ok: true, ...data });
  } catch (error) {
    await writeVentasSyncState({
      last_sync_at: new Date().toISOString(),
      last_sync_result: 'error',
      last_sync_message: String(error?.message || error),
    });
    return res.status(500).json({ ok: false, message: String(error?.message || error) });
  } finally {
    await releaseVentasSyncLock();
  }
}

