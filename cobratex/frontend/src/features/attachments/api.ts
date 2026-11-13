import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export interface Attachment {
  id: string;
  entity_type: string;
  entity_id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  created_at: string;
}

export function useAttachments(entityType: string, entityId: string | null) {
  return useQuery({
    queryKey: ['attachments', entityType, entityId],
    queryFn: async () => (await apiClient.get<Attachment[]>('/attachments', { params: { entityType, entityId } })).data,
    enabled: !!entityId,
  });
}

export function useUploadAttachment(entityType: string, entityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, branchId }: { file: File; branchId: string }) => {
      const form = new FormData();
      form.append('branchId', branchId);
      form.append('entityType', entityType);
      form.append('entityId', entityId);
      form.append('file', file);
      const res = await apiClient.post<Attachment>('/attachments', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      return res.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] }),
  });
}

export function useDeleteAttachment(entityType: string, entityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.delete(`/attachments/${id}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] }),
  });
}

/** يجلب الملف كـ blob عبر axios (لا رابط <a href> مباشر) عمدًا: التنزيل يتطلب ترويسة Authorization
 * (JWT)، ولا وسيلة لإرفاقها برابط عادي. يفتح الملف في تبويب جديد (صور/PDF تُعرَض مباشرة). */
export async function viewAttachment(id: string, fileName: string) {
  const res = await apiClient.get(`/attachments/${id}/download`, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data as Blob);
  const win = window.open(url, '_blank');
  if (!win) {
    // فتح النافذة مُنِع (حاجب نوافذ منبثقة) — نزِّل الملف مباشرة بدلًا من ذلك.
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
