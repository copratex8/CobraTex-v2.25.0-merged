import type { ReactNode } from 'react';
import { useBrand } from '@/brand/BrandProvider';
import { BrandLogo, DeveloperCredit } from '@/brand/BrandParts';
import { useCompany } from '@/features/catalog/api';
import { CLOUD_LABELS, checkCloud, useCloudStatus } from '@/cloud/cloudStatus';
import { APP_VERSION, useUpdateInfo } from '@/cloud/updates';
import { backendOrigin } from '@/api/client';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 py-2.5 text-sm last:border-0">
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold text-slate-900">{children}</span>
    </div>
  );
}

/** الإعدادات و"حول النظام": الهوية، حقوق التطوير، حالة السحابة، الإصدارات. للقراءة فقط — الهوية تُعدَّل من public/brand.json. */
export default function SettingsPage() {
  const brand = useBrand();
  const { data: company } = useCompany();
  const cloud = useCloudStatus();
  const { data: update, isFetching, refetch } = useUpdateInfo();
  const { data: server } = useQuery({
    queryKey: ['server-version'],
    queryFn: async () => (await apiClient.get<{ version: string }>('/system/version')).data.version,
    retry: false,
  });

  return (
    <div>
      <div className="page-hdr">
        <div>
          <h1>الإعدادات</h1>
          <p>الهوية، الاتصال بالسحابة، والتحديثات</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <div className="card-hdr"><span className="card-title">الهوية التجارية</span><span className="card-badge">White-label</span></div>
          <div className="mb-4 flex items-center gap-4">
            <BrandLogo size={72} className="ct-logo-ring" />
            <div>
              <p className="text-lg font-extrabold text-slate-900">{brand.appName}</p>
              <p className="text-sm text-slate-500" dir="ltr">{brand.appNameEn}</p>
              <p className="text-xs text-slate-400">{brand.tagline}</p>
            </div>
          </div>
          <Row label="اسم الجهة / الشركة">{company?.display_name ?? brand.companyName}</Row>
          {company && <Row label="الاسم القانوني">{company.legal_name}</Row>}
          {company && <Row label="العملة الأساسية">{company.base_currency_code}</Row>}
          <p className="mt-3 text-xs leading-6 text-slate-400">
            لتغيير الاسم أو الشعار أو الألوان: عدِّل ملف <code dir="ltr">public/brand.json</code> فقط (راجع docs/WHITE-LABEL.md).
          </p>
        </section>

        <section className="card">
          <div className="card-hdr"><span className="card-title">الاتصال بالسحابة</span></div>
          <Row label="الحالة">
            <span className="inline-flex items-center gap-2"><span className={`ct-cloud-dot ${cloud.state}`} />{CLOUD_LABELS[cloud.state]}</span>
          </Row>
          <Row label="زمن الاستجابة">{cloud.latencyMs != null ? `${cloud.latencyMs} ms` : '—'}</Row>
          <Row label="عنوان الخادم"><span dir="ltr" className="text-xs">{backendOrigin}</span></Row>
          <button onClick={() => void checkCloud()} className="btn btn-outline btn-sm mt-3">إعادة فحص الاتصال</button>
        </section>

        <section className="card">
          <div className="card-hdr"><span className="card-title">الإصدارات والتحديثات</span></div>
          <Row label="إصدار الواجهة"><span dir="ltr">{APP_VERSION}</span></Row>
          <Row label="إصدار الخادم"><span dir="ltr">{server ?? '—'}</span></Row>
          <Row label="أحدث إصدار متاح"><span dir="ltr">{update?.latestVersion ?? '—'}</span></Row>
          <Row label="حالة التحديث">{update ? (update.updateAvailable ? 'يتوفر تحديث' : 'محدَّث') : '—'}</Row>
          {update?.note && <p className="mt-2 text-xs text-slate-400">{update.note}</p>}
          <button onClick={() => void refetch()} disabled={isFetching} className="btn btn-outline btn-sm mt-3">
            {isFetching ? 'جارٍ الفحص…' : 'فحص التحديثات'}
          </button>
        </section>

        <section className="card">
          <div className="card-hdr"><span className="card-title">حقوق التطوير</span></div>
          <div className="rounded-xl p-4 text-center" style={{ background: 'linear-gradient(135deg,var(--navy),var(--navy2))' }}>
            <p className="mb-1 text-sm font-bold" style={{ color: 'var(--gold)' }}>{brand.developer.name}</p>
            <DeveloperCredit className="text-xs leading-6 text-white/70" />
          </div>
          {(brand.supportPhone || brand.supportEmail || brand.website) && (
            <div className="mt-3">
              {brand.supportPhone && <Row label="الدعم الفني (هاتف)"><span dir="ltr">{brand.supportPhone}</span></Row>}
              {brand.supportEmail && <Row label="الدعم الفني (بريد)"><span dir="ltr">{brand.supportEmail}</span></Row>}
              {brand.website && <Row label="الموقع"><span dir="ltr">{brand.website}</span></Row>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
