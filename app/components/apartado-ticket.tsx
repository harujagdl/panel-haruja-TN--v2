type Producto = {
  codigo?: string;
  descripcion?: string;
  cantidad?: number;
  precio?: number;
  subtotal?: number;
};

type ApartadoData = {
  folio?: string;
  fecha?: string;
  cliente?: string;
  telefono?: string;
  contacto?: string;
  subtotal?: number;
  anticipo?: number;
  descuento?: number;
  total?: number;
  productos?: Producto[];
};

function money(value?: number) {
  const n = Number(value || 0);
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2 })}`;
}

export function ApartadoTicket({
  apartado,
  mode = "default",
}: {
  apartado: ApartadoData;
  mode?: "default" | "pdf";
}) {
  const items = apartado.productos || [];

  return (
    <section data-pdf-ticket={mode === "pdf" ? "true" : undefined}>
      <div className="top-row">
        <div>Ticket de apartado</div>
        <div>#{apartado.folio || ""}</div>
      </div>

      <div>
        <div>Fecha: {apartado.fecha || ""}</div>
        <div>Cliente: {apartado.cliente || ""}</div>
        <div>Contacto: {apartado.telefono || apartado.contacto || ""}</div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Código</th>
            <th>Descripción</th>
            <th>Cant</th>
            <th>P.U.</th>
            <th>Importe</th>
          </tr>
        </thead>
        <tbody>
          {items.length ? (
            items.map((item, idx) => (
              <tr key={`${item.codigo || "row"}-${idx}`}>
                <td>{item.codigo || ""}</td>
                <td>{item.descripcion || ""}</td>
                <td>{item.cantidad || 1}</td>
                <td>{money(item.precio)}</td>
                <td>{money(item.subtotal)}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={5}>No hay productos</td>
            </tr>
          )}
        </tbody>
      </table>

      <div>
        <div>Subtotal: {money(apartado.subtotal)}</div>
        <div>Anticipo: {money(apartado.anticipo)}</div>
        <div>Descuento: {money(apartado.descuento)}</div>
        <div>Total: {money(apartado.total)}</div>
      </div>
    </section>
  );
}
