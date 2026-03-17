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
  return `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
}

export function ApartadoTicket({
  apartado,
  mode = 'screen',
}: {
  apartado: ApartadoData;
  mode?: 'screen' | 'pdf';
}) {
  const items = apartado.productos || [];
  const isPdf = mode === 'pdf';

  return (
    <section className={isPdf ? 'ticket-pdf' : undefined} data-pdf-ticket={isPdf ? 'true' : undefined}>
      {!isPdf ? <div className="toolbar">Ticket de apartado</div> : null}

      <div className="top-row avoid-break">
        <div>Ticket de apartado</div>
        <div>#{apartado.folio || ''}</div>
      </div>

      <div className="avoid-break">
        <div>Fecha: {apartado.fecha || ''}</div>
        <div>Cliente: {apartado.cliente || ''}</div>
        <div>Contacto: {apartado.telefono || apartado.contacto || ''}</div>
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
              <tr key={`${item.codigo || 'row'}-${idx}`}>
                <td>{item.codigo || ''}</td>
                <td>{item.descripcion || ''}</td>
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

      <div className="avoid-break">
        <div>Subtotal: {money(apartado.subtotal)}</div>
        <div>Anticipo: {money(apartado.anticipo)}</div>
        <div>Descuento: {money(apartado.descuento)}</div>
        <div>Total: {money(apartado.total)}</div>
      </div>

      {!isPdf ? <div className="actions">Acciones</div> : null}
    </section>
  );
}
