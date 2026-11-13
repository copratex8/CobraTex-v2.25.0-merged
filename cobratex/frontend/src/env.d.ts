/** يُحقَن وقت البناء من package.json عبر vite.config.ts (define). */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_BRAND_CONFIG_URL?: string;
  /** 'supabase' = الدخول عبر Supabase Auth؛ غير ذلك = legacy (راجع src/lib/supabaseClient.ts). */
  readonly VITE_AUTH_MODE?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_CSP?: string;
}
