import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_BRAND, applyBrandToDocument, loadBrand, type BrandConfig } from '@/brand/brand.config';

const BrandContext = createContext<BrandConfig>(DEFAULT_BRAND);

/** يحمّل الهوية مرة عند الإقلاع. تُرسم الواجهة فورًا بالقيم الافتراضية ثم تتحدّث إن اختلف /brand.json. */
export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<BrandConfig>(DEFAULT_BRAND);

  useEffect(() => {
    let cancelled = false;
    loadBrand().then((b) => {
      if (cancelled) return;
      setBrand(b);
      applyBrandToDocument(b);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): BrandConfig {
  return useContext(BrandContext);
}
