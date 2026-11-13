#!/usr/bin/env node
/**
 * يزامن public/brand.json مع الملفات الساكنة التي لا يمكن للواجهة تعديلها وقت التشغيل:
 *  *   - index.html                    (<title> و theme-color قبل تحميل JS)
 * بلا اعتماديات. يعمل تلقائيًا ضمن `npm run build` ويدويًا عبر `npm run brand:apply`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brand = JSON.parse(fs.readFileSync(path.join(root, 'public/brand.json'), 'utf8'));

const need = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`brand.json: الحقل "${name}" مطلوب`);
  return v;
};
const appName = need(brand.appName, 'appName');
const appNameEn = need(brand.appNameEn, 'appNameEn');
const navy = need(brand.theme?.navy, 'theme.navy');


const htmlPath = path.join(root, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
html = html
  .replace(/<title>[\s\S]*?<\/title>/, `<title>${appName} | ${appNameEn}</title>`)
  .replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1${navy}$2`)
  .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${appName}$2`);
fs.writeFileSync(htmlPath, html);

console.log(`apply-brand: ${appName} (${appNameEn}) — index.html محدَّث (الـ manifest يُولَّد الآن من brand.json داخل vite.config.ts عبر vite-plugin-pwa).`);
