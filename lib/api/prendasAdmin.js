import { createSheetsClient, getSpreadsheetId } from "../google/sheetsClient.js";
import { calcularUtilidadYMargenDesdeBaseVenta, normalizeNumber as normalizePricingNumber } from "../../shared/pricing-utils.js";

const ACTIVE_SHEET = "prendas_admin_activas";
const ARCHIVE_SHEET = "prendas_admin_archivo";
const TARGET_RANGE = `${ACTIVE_SHEET}!A1:R3000`;
const TARGET_SHEET = ACTIVE_SHEET;
const CODE_HEADER = "Código";

const EDITABLE_COLUMNS = ["Descripción", "Tipo", "Color", "Talla", "Proveedor", "Precio", "Costo", "Margen", "Utilidad", "Existencia", "Existencias", "Status", "Disponibilidad", "Fecha", "TN", "InventorySource", "LastInventorySyncAt"];
const NUMERIC_COLUMNS = new Set(["Precio", "Costo", "Margen", "Utilidad", "Existencia", "Existencias"]);
const SAFE_STATUS_VALUES = new Set(["NO DEFINIDO", "DISPONIBLE", "APARTADO", "VENDIDO", "AGOTADO", "ARCHIVADO"]);
const SAFE_DISPONIBILIDAD_VALUES = new Set(["NO DEFINIDO", "DISPONIBLE", "NO DISPONIBLE", "APARTADO", "AGOTADO", "VENDIDO"]);
const UPDATE_ALLOWED_PAYLOAD_KEYS = new Set(["codigo", "precio", "costo", "status", "disponibilidad", "existencia"]);

const pickValue = (row, headerNames = []) => {
  for (const headerName of headerNames) {
    const value = String(row?.[headerName] || "").trim();
    if (value) return value;
  }
  return "";
};

async function getSheetHeaders(sheets, sheetName) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${sheetName}!A1:ZZ1` });
  return (response?.data?.values?.[0] || []).map((header) => String(header || "").trim());
}

async function getSpreadsheetSheetNames(sheets) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: getSpreadsheetId(), includeGridData: false });
  return (metadata?.data?.sheets || []).map((sheet) => String(sheet?.properties?.title || "").trim()).filter(Boolean);
}

async function readSheetRows(sheets, sheetName) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${sheetName}!A:ZZ` });
  const values = response?.data?.values || [];
  const headers = (values[0] || []).map((header) => String(header || "").trim());
  const rows = values.slice(1).map((row, index) => {
    const sourceRowObject = {};
    headers.forEach((header, columnIndex) => {
      if (!header) return;
      sourceRowObject[header] = String(row?.[columnIndex] || "").trim();
    });
    return { rowNumber: index + 2, sourceRowObject };
  });
  return { headers, rows };
}

async function appendSheetRow(sheets, sheetName, values) {
  await sheets.spreadsheets.values.append({ spreadsheetId: getSpreadsheetId(), range: `${sheetName}!A:ZZ`, valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS", requestBody: { majorDimension: "ROWS", values: [values] } });
}

async function getSheetId(sheets, sheetName) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: getSpreadsheetId(), includeGridData: false });
  const targetSheet = (metadata?.data?.sheets || []).find((sheet) => sheet?.properties?.title === sheetName);
  return targetSheet?.properties?.sheetId;
}

async function deleteSheetRow(sheets, sheetName, rowNumber) {
  const sheetId = await getSheetId(sheets, sheetName);
  if (!Number.isInteger(sheetId)) throw new Error(`No se pudo resolver la hoja: ${sheetName}.`);
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: getSpreadsheetId(), requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber } } }] } });
}

function buildRowByTargetHeaders(sourceRowObject, targetHeaders) {
  return (Array.isArray(targetHeaders) ? targetHeaders : []).map((header) => {
    const safeHeader = String(header || "").trim();
    if (!safeHeader) return "";
    if (Object.prototype.hasOwnProperty.call(sourceRowObject || {}, safeHeader)) return sourceRowObject[safeHeader];
    return "";
  });
}

const normalizeCode = (value) => String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
const normalizeText = (value) => String(value ?? "").trim();
const normalizeNumber = (value, { integer = false } = {}) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return integer ? Math.trunc(value) : value;
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
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range });
  const values = response?.data?.values || [];
  if (!values.length) return { headers: [], rows: [] };
  const headers = (values[0] || []).map((header) => String(header || "").trim());
  const rows = values.slice(1).map((rowValues, index) => {
    const rowObject = {};
    headers.forEach((header, headerIndex) => { rowObject[header] = rowValues[headerIndex] ?? ""; });
    return { row: rowObject, sheetRowNumber: index + 2 };
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
  await sheets.spreadsheets.values.update({ spreadsheetId: getSpreadsheetId(), range: `${TARGET_SHEET}!A${rowNumber}:R${rowNumber}`, valueInputOption: "USER_ENTERED", requestBody: { majorDimension: "ROWS", values: [orderedValues] } });
};

export async function listArchivedPrendas() {
  const sheets = createSheetsClient({ readOnly: true });
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${ARCHIVE_SHEET}!A:ZZ` });
  const values = response?.data?.values || [];
  if (!values.length) return [];
  const headers = (values[0] || []).map((header) => String(header || "").trim());
  return values.slice(1).map((row) => {
    const source = {};
    headers.forEach((header, index) => { if (header) source[header] = String(row?.[index] || "").trim(); });
    return {
      codigo: pickValue(source, ["Código", "Codigo"]), descripcion: pickValue(source, ["Descripción", "Descripcion"]), tipo: pickValue(source, ["Tipo"]), color: pickValue(source, ["Color"]), talla: pickValue(source, ["Talla"]), proveedor: pickValue(source, ["Proveedor"]), precio: pickValue(source, ["Precio"]), fecha: pickValue(source, ["Fecha"]), archivedAt: pickValue(source, ["ArchivedAt"])
    };
  });
}

export async function restorePrenda(payload = {}) {
  const codigo = String(payload.codigo || "").trim();
  if (!codigo) throw new Error("El campo 'codigo' es obligatorio.");
  const sheets = createSheetsClient();
  const sheetNames = await getSpreadsheetSheetNames(sheets);
  if (!sheetNames.includes(ARCHIVE_SHEET)) throw new Error("No existe la hoja prendas_admin_archivo");
  if (!sheetNames.includes(ACTIVE_SHEET)) throw new Error("No existe la hoja prendas_admin_activas");

  const archivedData = await readSheetRows(sheets, ARCHIVE_SHEET);
  const activeHeaders = await getSheetHeaders(sheets, ACTIVE_SHEET);
  const archivedRow = archivedData.rows.find((row) => String(row?.sourceRowObject?.[CODE_HEADER] || "").trim() === codigo);
  if (!archivedRow) return { status: 404, body: { ok: false, message: "Código no encontrado en archivo." } };

  const restoreRowValues = buildRowByTargetHeaders(archivedRow.sourceRowObject, activeHeaders);
  await appendSheetRow(sheets, ACTIVE_SHEET, restoreRowValues);
  await deleteSheetRow(sheets, ARCHIVE_SHEET, archivedRow.rowNumber);
  return { ok: true, codigo, restored: true };
}

export async function importCorrections(payload = {}) {
  const rows = Array.isArray(payload.rows) ? payload.rows : null;
  const dryRun = Boolean(payload.dryRun);
  if (!rows) throw new Error("El payload debe incluir rows[]");

  const sheets = createSheetsClient();
  const { headers, rows: sheetRows } = await readSheetAsObjects(sheets, TARGET_RANGE);
  if (!headers.length) throw new Error("La hoja prendas_admin_activas no tiene encabezados.");

  const byCode = new Map();
  sheetRows.forEach((sheetEntry) => {
    const normalized = normalizeCode(sheetEntry?.row?.["Código"]);
    if (!normalized || byCode.has(normalized)) return;
    byCode.set(normalized, sheetEntry);
  });

  const summary = { ok: true, totalFilas: rows.length, encontrados: 0, noEncontrados: 0, actualizados: 0, errores: 0, detalles: [] };

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
    warnings.forEach((warning) => summary.detalles.push(`${normalizedCode} → aviso: ${warning}`));
    if (!hasChanges) {
      summary.detalles.push(`${normalizedCode} → sin cambios`);
      continue;
    }

    if (!dryRun) {
      try {
        await updateSheetRow(sheets, headers, match.sheetRowNumber, updatedRow);
      } catch (error) {
        summary.errores += 1;
        summary.detalles.push(`${normalizedCode} → error: ${error?.message || "falló update"}`);
        continue;
      }
    }

    summary.actualizados += 1;
    summary.detalles.push(`${normalizedCode} → ${dryRun ? "actualizable" : "actualizado"}`);
  }

  return summary;
}

export async function updatePrenda(payload = {}) {
  const codigo = String(payload?.codigo || "").trim();
  if (!codigo) throw new Error("El campo 'codigo' es obligatorio.");
  const payloadKeys = Object.keys(payload || {});
  const unknownKeys = payloadKeys.filter((key) => !UPDATE_ALLOWED_PAYLOAD_KEYS.has(String(key || "").trim()));
  if (unknownKeys.length) {
    console.warn("[prendas:update] payload con campos ignorados", { codigo, ignoredKeys: unknownKeys });
  }

  const parseMoneyOrThrow = (value, fieldName) => {
    const parsed = normalizePricingNumber(value);
    if (parsed === null || !Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`El campo '${fieldName}' es inválido.`);
    }
    return parsed;
  };
  const parseExistenciaOrThrow = (value) => {
    const parsed = normalizeNumber(value, { integer: true });
    if (parsed === null || !Number.isFinite(parsed) || parsed < 0) {
      throw new Error("El campo 'existencia' es inválido.");
    }
    return parsed;
  };
  const parseEnumOrThrow = (value, validSet, fieldName) => {
    const normalized = normalizeText(value).toUpperCase();
    if (!normalized) throw new Error(`El campo '${fieldName}' es obligatorio.`);
    if (!validSet.has(normalized)) throw new Error(`El campo '${fieldName}' es inválido.`);
    return normalized
      .toLowerCase()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  };

  const hasPrecio = Object.prototype.hasOwnProperty.call(payload, "precio");
  const hasCosto = Object.prototype.hasOwnProperty.call(payload, "costo");
  const hasStatus = Object.prototype.hasOwnProperty.call(payload, "status");
  const hasDisponibilidad = Object.prototype.hasOwnProperty.call(payload, "disponibilidad");
  const hasExistencia = Object.prototype.hasOwnProperty.call(payload, "existencia");

  if (!hasPrecio && !hasCosto && !hasStatus && !hasDisponibilidad && !hasExistencia) {
    throw new Error("No se enviaron campos editables permitidos.");
  }

  const sheets = createSheetsClient();
  const { headers, rows } = await readSheetRows(sheets, ACTIVE_SHEET);
  if (!headers.length) throw new Error("La hoja prendas_admin_activas no tiene encabezados.");

  const codeIndex = headers.findIndex((header) => String(header || "").trim() === CODE_HEADER);
  if (codeIndex < 0) throw new Error("No se encontró la columna Código en prendas_admin_activas.");

  const normalizedCode = normalizeCode(codigo);
  const matchedRow = rows.find((entry) => normalizeCode(entry?.sourceRowObject?.[CODE_HEADER]) === normalizedCode);
  if (!matchedRow) {
    return { status: 404, body: { ok: false, message: "Código no encontrado en prendas_admin_activas." } };
  }

  const existenciaHeader = headers.includes("Existencia")
    ? "Existencia"
    : (headers.includes("Existencias") ? "Existencias" : "Existencia");
  const nextRowObject = { ...(matchedRow.sourceRowObject || {}) };
  const precioFromPayload = hasPrecio
    ? parseMoneyOrThrow(payload.precio, "precio")
    : null;
  const costoFromPayload = hasCosto
    ? parseMoneyOrThrow(payload.costo, "costo")
    : null;
  const precioFinal = precioFromPayload ?? normalizePricingNumber(nextRowObject.Precio) ?? 0;
  const costoFinal = costoFromPayload ?? normalizePricingNumber(nextRowObject.Costo) ?? 0;
  const { utilidad, margen } = calcularUtilidadYMargenDesdeBaseVenta(precioFinal, costoFinal);

  if (hasPrecio && headers.includes("Precio")) nextRowObject.Precio = String(precioFromPayload);
  if (hasCosto && headers.includes("Costo")) nextRowObject.Costo = String(costoFromPayload);
  if (hasStatus && headers.includes("Status")) nextRowObject.Status = parseEnumOrThrow(payload.status, SAFE_STATUS_VALUES, "status");
  if (hasDisponibilidad && headers.includes("Disponibilidad")) {
    nextRowObject.Disponibilidad = parseEnumOrThrow(payload.disponibilidad, SAFE_DISPONIBILIDAD_VALUES, "disponibilidad");
  }
  if (hasExistencia && headers.includes(existenciaHeader)) {
    nextRowObject[existenciaHeader] = String(parseExistenciaOrThrow(payload.existencia));
  }
  if (headers.includes("Utilidad")) nextRowObject.Utilidad = String(utilidad);
  if (headers.includes("Margen")) nextRowObject.Margen = String(margen);

  const orderedValues = headers.map((header) => nextRowObject[header] ?? "");
  await sheets.spreadsheets.values.update({
    spreadsheetId: getSpreadsheetId(),
    range: `${ACTIVE_SHEET}!A${matchedRow.rowNumber}:ZZ${matchedRow.rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { majorDimension: "ROWS", values: [orderedValues] },
  });

  return { ok: true, codigo: normalizedCode, updated: true };
}
