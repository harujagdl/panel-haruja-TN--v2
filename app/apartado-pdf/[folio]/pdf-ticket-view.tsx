"use client";

import { useEffect, useState } from "react";
import { ApartadoTicket } from "../../components/apartado-ticket";

type ApiPayload = {
  apartado?: Record<string, unknown>;
} & Record<string, unknown>;

export function PdfTicketView({ folio }: { folio: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/core?action=apartados&op=detail&folio=${encodeURIComponent(folio)}`);
        const payload = (await res.json()) as ApiPayload;
        const detail = (payload?.data as ApiPayload)?.apartado || payload?.apartado || payload;
        if (!cancelled) setData(detail as Record<string, unknown>);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudo cargar el ticket");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [folio]);

  if (error) return <div>{error}</div>;
  if (!data) return <div>Cargando…</div>;

  return <ApartadoTicket apartado={data as any} mode="pdf" />;
}
