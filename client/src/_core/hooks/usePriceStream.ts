import { useEffect, useRef, useState, useCallback } from "react";

export interface PriceUpdate {
  symbol: string;
  price: number;
  volume: number;
  timestamp: number;
}

/**
 * Hook that connects to the SSE price stream endpoint.
 * Returns a live map of symbol → latest price, updated in real-time.
 */
export function usePriceStream() {
  const [prices, setPrices] = useState<Record<string, PriceUpdate>>({});
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/prices/stream");
    eventSourceRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "snapshot" && data.prices) {
          // Initial bulk update from cached prices
          setPrices(data.prices);
        } else if (data.type === "update") {
          // Single price tick
          setPrices((prev) => ({
            ...prev,
            [data.symbol]: {
              symbol: data.symbol,
              price: data.price,
              volume: data.volume,
              timestamp: data.timestamp,
            },
          }));
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setConnected(false);
    };
  }, []);

  /**
   * Subscribe to symbols via the REST endpoint.
   * The SSE stream will start receiving updates for these symbols.
   */
  const subscribe = useCallback(async (symbols: string[]) => {
    try {
      await fetch("/api/prices/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols }),
      });
    } catch (error) {
      console.error("[PriceStream] Subscribe error:", error);
    }
  }, []);

  return { prices, connected, subscribe };
}
