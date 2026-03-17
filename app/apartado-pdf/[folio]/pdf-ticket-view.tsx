"use client";

import { useEffect, useState } from "react";
import { ApartadoTicket } from "../../components/apartado-ticket";

type ApiPayload = {
  apartado?: Record<string, unknown>;
  data?: {
    apartado?: Record<string, unknown>;
    message?: string;
    ok?: boolean;
  };
  message?: string;
  ok?: boolean;
} & Record<string, unknown>;

export function PdfTicketView({ folio }: { folio: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/core?action=apartados&op=detail&folio=${encodeURIComponent(folio)}`, {
          cache: "no-store",
        });
        const text = await res.text();

        let payload: ApiPayload;
        try {
          payload = JSON.parse(text) as ApiPayload;
        } catch {
          throw new Error(`Respuesta no válida del backend: ${text}`);
        }

        const detail = (payload?.data as ApiPayload)?.apartado || payload?.apartado || payload;
        const message = payload?.message || payload?.data?.message || "No se pudo cargar el apartado";
        if (!res.ok || payload?.ok === false || payload?.data?.ok === false) {
          throw new Error(String(message));
        }

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
