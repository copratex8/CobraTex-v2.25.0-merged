import { useEffect, useState } from 'react';

/** شريط «لا يوجد اتصال». (تجربة تثبيت التطبيق انتقلت إلى InstallAppButton + installStore.) */
export default function PwaPrompts() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online) return null;
  return (
    <div role="status" className="ct-no-print flex items-center justify-center gap-2 bg-red-600 px-4 py-2 text-sm font-semibold text-white">
      لا يوجد اتصال بالإنترنت — البيانات المعروضة قد لا تكون محدّثة، ولن تُحفظ أي عملية حتى يعود الاتصال.
    </div>
  );
}
