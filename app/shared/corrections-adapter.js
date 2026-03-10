export async function processCorrectionsFileRows({ rows, dryRun }) {
  const response = await fetch("/api/prendas-import-corrections", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ rows: Array.isArray(rows) ? rows : [], dryRun: Boolean(dryRun) })
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.message || `Error procesando correcciones (HTTP ${response.status})`);
  }

  return payload;
}
