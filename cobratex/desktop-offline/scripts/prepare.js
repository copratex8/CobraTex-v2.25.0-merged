#!/usr/bin/env node
/**
 * يجهّز "الحمولة" (payload) التي تُضمَّن داخل الـexe:
 *   1) يبني الباك إند (tsc + إصلاح الاختصارات @/)         → payload/backend/dist
 *   2) يبني الواجهة بعنوان API نسبي /api                   → payload/frontend
 *   3) ينسخ الهجرات والإضافات وVERSION                     → payload/backend/...
 *   4) يولّد build/icon.ico من شعار كوبرا تكس إن لم يوجد
 * ثم يثبّت electron-builder كل مكتبات desktop/node_modules (مجموعة تشغيل الخادم + embedded-postgres) داخل الملف.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const desktop = path.resolve(__dirname, '..');
const payload = path.join(desktop, 'payload');
const run = (cmd, cwd, env = {}) => { console.log(`\n$ ${cmd}  (${path.relative(root, cwd) || '.'})`); execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } }); };
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });

fs.rmSync(payload, { recursive: true, force: true });
fs.mkdirSync(path.join(payload, 'backend'), { recursive: true });

// 1) الباك إند
const be = path.join(root, 'backend');
if (!fs.existsSync(path.join(be, 'node_modules'))) run('npm ci', be);
run('npm run build', be, { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'x', JWT_REFRESH_SECRET: 'x' });
copy(path.join(be, 'dist'), path.join(payload, 'backend', 'dist'));
copy(path.join(be, 'src', 'db', 'migrations'), path.join(payload, 'backend', 'migrations'));
if (fs.existsSync(path.join(be, 'plugins'))) copy(path.join(be, 'plugins'), path.join(payload, 'backend', 'plugins'));
fs.copyFileSync(path.join(be, 'VERSION'), path.join(payload, 'backend', 'VERSION'));

// 2) الواجهة (عنوان API نسبي: نفس الأصل الذي يخدمه الغلاف)
const fe = path.join(root, 'frontend');
if (!fs.existsSync(path.join(fe, 'node_modules'))) run('npm ci', fe);
run('npm run build', fe, { VITE_API_BASE_URL: '/api' });
copy(path.join(fe, 'dist'), path.join(payload, 'frontend'));

// 3) أيقونة التثبيت
fs.mkdirSync(path.join(desktop, 'build'), { recursive: true });
const ico = path.join(desktop, 'build', 'icon.ico');
if (!fs.existsSync(ico)) {
  const png = path.join(fe, 'public', 'icon-512.png');
  const png256 = fs.readFileSync(png);
  // ICO بصيغة PNG مضمَّنة (يدعمها Windows Vista+): ترويسة 6 بايت + مدخل 16 بايت + بيانات PNG
  const hdr = Buffer.alloc(22);
  hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4);
  hdr[6] = 0; hdr[7] = 0; hdr[8] = 0; hdr[9] = 0; hdr.writeUInt16LE(1, 10); hdr.writeUInt16LE(32, 12);
  hdr.writeUInt32LE(png256.length, 14); hdr.writeUInt32LE(22, 18);
  fs.writeFileSync(ico, Buffer.concat([hdr, png256]));
  console.log('generated build/icon.ico from icon-512.png');
}
console.log('\n✔ payload جاهز في', payload);
