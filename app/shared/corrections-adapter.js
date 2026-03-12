export async function processCorrectionsFileRows({ rows, dryRun }) {
  const response = await fetch('/api/core?action=prendas-import-corrections', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ rows: Array.isArray(rows) ? rows : [], dryRun: Boolean(dryRun) })
  });

  const result = await response.json().catch(() => null);
  const payload = result?.data;

  if (!response.ok || result?.ok === false || !payload?.ok) {
    throw new Error(result?.message || payload?.message || `Error procesando correcciones (HTTP ${response.status})`);
  }

  return payload;
}
