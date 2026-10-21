// Test cases for scale-front-http-client-defaults (invented notes platform).
import axios from 'axios';
import { QueryClient } from '@tanstack/react-query';

// ruleid: scale-front-http-client-defaults
axios.defaults.timeout = 300000;

// ruleid: scale-front-http-client-defaults
export const exportsApi = axios.create({ baseURL: '/exports', timeout: 600000 });

// ok: scale-front-http-client-defaults
export const notesApi = axios.create({ baseURL: '/notes', timeout: 30000 });

// ruleid: scale-front-http-client-defaults
export const bareClient = new QueryClient();

// ruleid: scale-front-http-client-defaults
export const retryOnlyClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

// ok: scale-front-http-client-defaults
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } },
});
