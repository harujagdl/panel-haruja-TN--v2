import { readVentasSyncState, writeVentasSyncState } from '../../lib/ventas/syncState.js';

function present(value, fallback) {
  const raw = String(value || '').trim();
  return raw || fallback;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  try {
    const state = await readVentasSyncState();
    if (!String(state.mode || '').trim()) {
      await writeVentasSyncState({ mode: 'automatico' });
      state.mode = 'automatico';
    }

    return res.status(200).json({
      ok: true,
      mode: present(state.mode, 'automatico'),
      last_event_received_at: present(state.last_event_received_at, ''),
      last_event_type: present(state.last_event_type, ''),
      last_order_processed_at: present(state.last_order_processed_at, ''),
      last_order_name: present(state.last_order_name, ''),
      last_order_id: present(state.last_order_id, ''),
      last_sync_at: present(state.last_sync_at, ''),
      last_sync_result: present(state.last_sync_result, ''),
      last_sync_message: present(state.last_sync_message, ''),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: String(error?.message || error) });
  }
}

