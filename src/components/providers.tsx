"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * TanStack Query provider for the org shell. Query clients are created once per
 * mount; server actions / route handlers remain the source of truth for
 * mutations (design §2: server actions for mutations, TanStack Query for client
 * caching).
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  );
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
