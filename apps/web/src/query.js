/** TanStack Query client + academic query-key factory (single-tenant standalone). */
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

export const qk = {
  athletes: () => ['athletes'],
  athlete: (id) => ['athlete', id],
  mentors: () => ['mentors'],
  moduleProfiles: () => ['module-profiles'],
  checkIns: () => ['check-ins'],
  interventions: () => ['interventions'],
};
