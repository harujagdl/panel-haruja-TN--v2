import { PdfTicketView } from "./pdf-ticket-view";

export default function ApartadoPdfPage({ params }: { params: { folio: string } }) {
  return <PdfTicketView folio={decodeURIComponent(params.folio)} />;
}
