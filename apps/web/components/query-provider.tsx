"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// One QueryClient per browser tab, created lazily inside useState so it
// survives re-renders but isn't shared across requests on the server (see
// TanStack's Next.js App Router guidance). staleTime 0 + each page's own
// refetchInterval reproduces the old "poll every N seconds" behavior;
// refetchOnWindowFocus stays on since that's a free improvement over the
// old hand-rolled polls, which never refetched on focus at all.
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 0 } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
