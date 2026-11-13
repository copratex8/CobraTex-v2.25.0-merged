#!/usr/bin/env node
/**
 * يحوّل مسارات الاستيراد المستعارة (`@/…`) في ناتج tsc إلى مسارات نسبية حقيقية.
 *
 * لماذا؟ tsc يحافظ على `require("@/app")` كما هي في ملفات JS الناتجة، و Node لا يعرف هذا الاسم
 * المستعار — فيفشل `node dist/src/server.js` بخطأ "Cannot find module '@/app'". محليًا يحلّها
 * tsconfig-paths وقت التطوير فقط. هذا السكربت (بلا أي اعتماديات) يجعل ناتج البناء قابلًا للتشغيل
 * مباشرة على Docker/Render وكذلك قابلًا للتتبّع الساكن على Vercel Serverless.
 *
 * الاستخدام: node scripts/fix-aliases.js [dist]   (يُستدعى تلقائيًا من `npm run build`)
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || 'dist');
const srcRoot = path.join(root, 'src'); // الاسم المستعار @/* ← src/*
if (!fs.existsSync(srcRoot)) {
  console.error(`fix-aliases: المجلد غير موجود: ${srcRoot}`);
  process.exit(1);
}

let files = 0;
let rewrites = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) fix(full);
  }
}

function fix(file) {
  const original = fs.readFileSync(file, 'utf8');
  const updated = original.replace(/(require\(\s*|from\s+|import\(\s*)(["'])@\/([^"']+)\2/g, (_m, prefix, quote, target) => {
    let rel = path.relative(path.dirname(file), path.join(srcRoot, target)).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    rewrites++;
    return `${prefix}${quote}${rel}${quote}`;
  });
  files++;
  if (updated !== original) fs.writeFileSync(file, updated);
}

walk(root);

// فحص نهائي: لا يجب أن يبقى أي استيراد مستعار.
const leftovers = [];
(function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full);
    else if (entry.name.endsWith('.js') && /require\(\s*["']@\//.test(fs.readFileSync(full, 'utf8'))) leftovers.push(full);
  }
})(root);
if (leftovers.length) {
  console.error('fix-aliases: بقيت استيرادات مستعارة في:\n' + leftovers.join('\n'));
  process.exit(1);
}
console.log(`fix-aliases: فُحص ${files} ملفًا، أُعيدت كتابة ${rewrites} استيرادًا.`);
