interface PaginationControlsProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

/** يعكس تمامًا عقد paginatedList في الباك إند: page يبدأ من 1، totalPages = 0 عند عدم وجود بيانات. */
export default function PaginationControls({ page, total, totalPages, onPageChange }: PaginationControlsProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
      <span>
        الإجمالي: {total} — صفحة {page} من {totalPages}
      </span>
      <div className="flex gap-2">
        <button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-lg border border-slate-300 px-3 py-1 disabled:opacity-40"
        >
          السابق
        </button>
        <button
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-lg border border-slate-300 px-3 py-1 disabled:opacity-40"
        >
          التالي
        </button>
      </div>
    </div>
  );
}
