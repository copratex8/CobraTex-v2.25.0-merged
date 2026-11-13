import { useSyncExternalStore } from 'react';
import type { AxiosInstance } from 'axios';
import type { BrandConfig } from '@/brand/brand.config';

/**
 * نظام الإضافات (Frontend Plugins) — مستخلص من محمّل بلوجن الهدى (PLUGIN_API.register + plugins/manifest.json)
 * ومُعاد بناؤه فوق واجهة React/جي تك:
 *   - إضافة جديدة = ملف JS في public/plugins/ + سطر في public/plugins/manifest.json. لا بناء ولا تعديل كود أساسي.
 *   - الإضافة تحصل على سياق آمن (ctx) فيه عميل API مُصادَق عليه (نفس توكن المستخدم وعزل المستأجر في الباك إند)،
 *     لا وصول مباشر لقاعدة البيانات (بخلاف الهدى حيث كانت IndexedDB محلية).
 *   - إضافات الباك إند (backend/plugins/*) تبقى كما هي من جي تك وتظهر هنا بجانب إضافات الواجهة.
 */

export interface PluginContext {
  /** عميل axios جاهز بالتوكن وتجديد الجلسة التلقائي. استدعِ مسارات /api مثل: ctx.api.get('/customers'). */
  api: AxiosInstance;
  /** أصل الخادم (بلا /api) — لمسارات مثل /health. */
  backendOrigin: string;
  brand: BrandConfig;
  appVersion: string;
  toast: (message: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
  navigate: (path: string) => void;
}

export interface CobraPlugin {
  /** معرّف فريد بحروف لاتينية/أرقام/شرطة (يظهر في الرابط /ext/<id>). */
  id: string;
  name: string;
  version?: string;
  description?: string;
  section?: {
    /** main|sales|purchasing|inventory|finance|system أو أي معرّف جديد لإنشاء مجموعة (استخدم groupLabel لاسمها). */
    group?: string;
    groupLabel?: string;
    icon?: string;
    /** نص عنصر القائمة (الافتراضي: name). */
    name?: string;
  };
  /** يرسم الإضافة داخل container. يُرجع (اختياريًا) دالة تنظيف تُستدعى عند مغادرة الصفحة. */
  mount: (container: HTMLElement, ctx: PluginContext) => void | (() => void);
}

export interface PluginLoadReport { file: string; ok: boolean; id?: string; error?: string }

const registry = new Map<string, CobraPlugin>();
let snapshot: CobraPlugin[] = [];
let reports: PluginLoadReport[] = [];
const listeners = new Set<() => void>();

function notify() {
  snapshot = [...registry.values()];
  for (const l of listeners) l();
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

export function registerPlugin(def: CobraPlugin): void {
  if (!def || typeof def !== 'object' || typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) {
    console.warn('[plugins] إضافة بلا id صالح — تم تجاهلها', def);
    return;
  }
  if (typeof def.mount !== 'function' || typeof def.name !== 'string') {
    console.warn(`[plugins] الإضافة "${def.id}" ينقصها name أو mount() — تم تجاهلها`);
    return;
  }
  registry.set(def.id, def); // إعادة التسجيل بنفس id = تحديث الإضافة
  notify();
}

export function setLoadReports(next: PluginLoadReport[]): void {
  reports = next;
  notify();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useFrontendPlugins(): CobraPlugin[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function useLoadReports(): PluginLoadReport[] {
  return useSyncExternalStore(subscribe, () => reports);
}

export function getFrontendPlugin(id: string): CobraPlugin | undefined {
  return registry.get(id);
}
