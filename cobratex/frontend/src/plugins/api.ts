import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export interface PluginDescriptor {
  name: string;
  version: string;
  description: string | null;
  customElementTag: string | null;
  navLabel: string | null;
  frontendEntryUrl: string | null;
}

/** لا مصادقة مطلوبة لهذا المسار في الباك إند (معلومات غير حسّاسة)، لكن apiClient يرفق التوكن تلقائيًا إن وُجد أصلًا — غير ضار. */
export function usePluginManifest() {
  return useQuery({
    queryKey: ['plugin-manifest'],
    queryFn: async () => (await apiClient.get<{ plugins: PluginDescriptor[] }>('/system/plugins')).data.plugins,
    staleTime: 60_000,
  });
}
