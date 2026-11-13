import { useRef, useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { useAttachments, useUploadAttachment, useDeleteAttachment, viewAttachment } from '@/features/attachments/api';
import { extractErrorMessage } from '@/api/client';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ك.ب`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} م.ب`;
}

const mimeIcon: Record<string, string> = {
  'application/pdf': '📄',
};

interface Props {
  entityType: string;
  entityId: string;
}

/** لوحة مرفقات قابلة للتضمين في أي صفحة تفاصيل مستند (فاتورة، شيك، صنف، جرد، تسوية بنكية...) —
 * entityType يجب أن يطابق أحد المفاتيح في ENTITY_TABLES بالباك إند (attachmentService.ts). */
export default function AttachmentsPanel({ entityType, entityId }: Props) {
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';
  const { data: attachments, isLoading } = useAttachments(entityType, entityId);
  const uploadAttachment = useUploadAttachment(entityType, entityId);
  const deleteAttachment = useDeleteAttachment(entityType, entityId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      await uploadAttachment.mutateAsync({ file, branchId });
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">المرفقات</h2>
        <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
          {uploadAttachment.isPending ? 'جارٍ الرفع...' : '+ إرفاق ملف'}
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" onChange={handleFileSelected} disabled={uploadAttachment.isPending} className="hidden" />
        </label>
      </div>

      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {isLoading && <p className="text-xs text-slate-400">جارٍ التحميل...</p>}

      {attachments && attachments.length === 0 && <p className="text-xs text-slate-400">لا مرفقات بعد — صور، PDF (حتى 5 م.ب لكل ملف).</p>}

      {attachments && attachments.length > 0 && (
        <ul className="space-y-2">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-sm">
              <button onClick={() => viewAttachment(a.id, a.file_name)} className="flex items-center gap-2 text-start text-slate-700 hover:underline">
                <span>{mimeIcon[a.mime_type] ?? '🖼️'}</span>
                <span>{a.file_name}</span>
                <span className="text-xs text-slate-400">({formatSize(a.file_size)})</span>
              </button>
              <button
                onClick={() => deleteAttachment.mutate(a.id)}
                disabled={deleteAttachment.isPending}
                className="text-xs text-red-600 hover:underline disabled:opacity-50"
              >
                حذف
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
