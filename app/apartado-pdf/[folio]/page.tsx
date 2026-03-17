import { ApartadoTicket } from '@/app/components/apartado-ticket';
import { getApartadoByFolio } from '@/lib/apartados';

export default async function ApartadoPdfPage({ params }: { params: { folio: string } }) {
  const data = await getApartadoByFolio(params.folio);

  return (
    <main className="pdf-page">
      <ApartadoTicket apartado={data} mode="pdf" />
      <style jsx global>{`
        @page {
          size: Letter;
          margin: 12mm;
        }

        html,
        body {
          margin: 0;
          padding: 0;
          background: #fff;
        }

        .pdf-page {
          background: #fff;
          display: flex;
          justify-content: center;
        }

        .ticket-pdf {
          width: 816px;
          max-width: 816px;
          background: #fff;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }

        .avoid-break {
          break-inside: avoid;
          page-break-inside: avoid;
        }
      `}</style>
    </main>
  );
}
