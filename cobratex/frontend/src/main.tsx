import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import '@/pwa/installStore'; // يلتقط beforeinstallprompt مبكرًا
import App from './App.tsx';
import { BrandProvider } from '@/brand/BrandProvider';
import { loadFrontendPlugins } from '@/plugins/loader';
import { WhatsAppFab } from '@/brand/DeveloperContact';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

// إضافات الواجهة تُحمَّل بعد الرسم الأول ولا تعطّل الإقلاع إن فشلت.
void loadFrontendPlugins();

// عامل الخدمة: إشعارات Web Push + صفحة عدم الاتصال + تحديث الواجهة بلا فقدان جلسة (المصدر: sw/sw.ts، يُبنى بـ vite-plugin-pwa).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrandProvider>
      <QueryClientProvider client={queryClient}>
        <App />
        <WhatsAppFab />
      </QueryClientProvider>
    </BrandProvider>
  </StrictMode>,
);
