import { google } from "googleapis";

const TARGET_SHEET = "prendas_admin_activas";
const TARGET_RANGE = `${TARGET_SHEET}!A1:R`;
const EDITABLE_COLUMNS = [
  "Descripción",
  "Tipo",
  "Color",
  "Talla",
  "Proveedor",
  "TN",
  "Status",
  "Disponibilidad",
  "Existencia",
  "Fecha",
  "Precio",
  "Costo",
  "Margen",
  "Utilidad",
  "InventorySource",
  "LastInventorySyncAt"
];
const NUMERIC_COLUMNS = new Set(["Existencia", "Precio", "Costo", "Margen", "Utilidad"]);

const createSheetsClient = () => {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: String(process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth });
};

const normalizeCode = (value) => String(value || "").trim().replace(/\s+/g, " ").toUpperCase();

const normalizeText = (value) => String(value ?? "").trim();

const normalizeNumber = (value, { integer = false } = {}) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return integer ? Math.trunc(value) : value;
  }
  const parsed = Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(parsed)) return null;
  return integer ? Math.trunc(parsed) : parsed;
};

const valueForComparison = (column, value) => {
  if (NUMERIC_COLUMNS.has(column)) {
    const parsed = normalizeNumber(value, { integer: column === "Existencia" });
    return parsed === null ? "" : String(parsed);
  }
  return normalizeText(value);
};

const readSheetAsObjects = async (sheets, range) => {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range
  });

  const values = response?.data?.values || [];
  if (!values.length) {
    return { headers: [], rows: [] };
  }

  const headers = (values[0] || []).map((header) => String(header || "").trim());
  const rows = values.slice(1).map((rowValues, index) => {
    const rowObject = {};
    headers.forEach((header, headerIndex) => {
      rowObject[header] = rowValues[headerIndex] ?? "";
    });
    return {
      row: rowObject,
      values: rowValues,
      sheetRowNumber: index + 2
    };
  });

  return { headers, rows };
};

const buildUpdatedRow = (existingRow, incomingRow) => {
  const updated = { ...existingRow };
  let hasChanges = false;
  const warnings = [];

  EDITABLE_COLUMNS.forEach((column) => {
    if (!Object.prototype.hasOwnProperty.call(incomingRow, column)) return;

    const incomingValue = incomingRow[column];
    if (NUMERIC_COLUMNS.has(column)) {
      const parsed = normalizeNumber(incomingValue, { integer: column === "Existencia" });
      if (parsed === null && incomingValue !== "" && incomingValue !== null && incomingValue !== undefined) {
        warnings.push(`valor inválido en ${column}, se conserva valor previo`);
        return;
      }
      const nextValue = parsed === null ? "" : String(parsed);
      if (valueForComparison(column, existingRow[column]) !== valueForComparison(column, nextValue)) {
        updated[column] = nextValue;
        hasChanges = true;
      }
      return;
    }

    const nextValue = normalizeText(incomingValue);
    if (valueForComparison(column, existingRow[column]) !== valueForComparison(column, nextValue)) {
      updated[column] = nextValue;
      hasChanges = true;
    }
  });

  return { updatedRow: updated, hasChanges, warnings };
};

const updateSheetRow = async (sheets, headers, rowNumber, rowObject) => {
  const orderedValues = headers.map((header) => rowObject[header] ?? "");
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${TARGET_SHEET}!A${rowNumber}:R${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      majorDimension: "ROWS",
      values: [orderedValues]
    }
  });
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const payload = req.body || {};
    const rows = Array.isArray(payload.rows) ? payload.rows : null;
    const dryRun = Boolean(payload.dryRun);

    if (!rows) {
      return res.status(400).json({ ok: false, message: "El payload debe incluir rows[]" });
    }

    const sheets = createSheetsClient();
    const { headers, rows: sheetRows } = await readSheetAsObjects(sheets, TARGET_RANGE);
    if (!headers.length) {
      return res.status(500).json({ ok: false, message: "La hoja prendas_admin_activas no tiene encabezados." });
    }

    const byCode = new Map();
    sheetRows.forEach((sheetEntry) => {
      const normalized = normalizeCode(sheetEntry?.row?.["Código"]);
      if (!normalized || byCode.has(normalized)) return;
      byCode.set(normalized, sheetEntry);
    });

    const summary = {
      ok: true,
      totalFilas: rows.length,
      encontrados: 0,
      noEncontrados: 0,
      actualizados: 0,
      errores: 0,
      detalles: []
    };

    for (let index = 0; index < rows.length; index += 1) {
      const incoming = rows[index] || {};
      const normalizedCode = normalizeCode(incoming["Código"]);
      if (!normalizedCode) {
        summary.errores += 1;
        summary.detalles.push(`fila ${index + 1} → error: falta Código`);
        continue;
      }

      const match = byCode.get(normalizedCode);
      if (!match) {
        summary.noEncontrados += 1;
        summary.detalles.push(`${normalizedCode} → no encontrado`);
        continue;
      }

      summary.encontrados += 1;
      const { updatedRow, hasChanges, warnings } = buildUpdatedRow(match.row, incoming);
      warnings.forEach((warning) => {
        summary.detalles.push(`${normalizedCode} → aviso: ${warning}`);
      });

      if (!hasChanges) {
        summary.detalles.push(`${normalizedCode} → sin cambios`);
        continue;
      }

      if (!dryRun) {
        try {
          await updateSheetRow(sheets, headers, match.sheetRowNumber, updatedRow);
          match.row = updatedRow;
        } catch (error) {
          summary.errores += 1;
          summary.detalles.push(`${normalizedCode} → error: ${error?.message || "falló update"}`);
          continue;
        }
      }

      summary.actualizados += 1;
      summary.detalles.push(`${normalizedCode} → ${dryRun ? "actualizable" : "actualizado"}`);
    }

    return res.status(200).json(summary);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "No se pudieron procesar las correcciones.",
      error: error?.message || "Unknown error"
    });
  }
}
