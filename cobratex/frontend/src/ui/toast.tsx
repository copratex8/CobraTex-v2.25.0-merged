import { useEffect, useState } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warn';
interface ToastItem { id: number; message: string; type: ToastType }

type Listener = (items: ToastItem[]) => void;
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

/** إشعار منبثق عام (يُستدعى من أي مكان، بما فيه الإضافات الخارجية) — لا يحتاج hook. */
export function toast(message: string, type: ToastType = 'info', ms = 3500): void {
  const id = nextId++;
  items = [...items, { id, message, type }];
  emit();
  window.setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, ms);
}

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="toast-wrap ct-no-print" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
