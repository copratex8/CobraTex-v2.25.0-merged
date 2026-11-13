# صورة إنتاج بسيطة للباك إند — تعمل على أي مزود يدعم Docker مجانًا (Render Free Web Service،
# Fly.io Free Allowance، Railway Free Trial). لا تعتمد على أي أداة بناء غير Node القياسي.
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/VERSION ./VERSION
# مجلد الإضافات يُنسخ كما هو (ملفات JS خام، لا يحتاج تجميعًا) — يبقى قابلاً للاستبدال بعد النشر
# عبر تحديث الملفات وإعادة تشغيل الحاوية فقط، بلا إعادة بناء الصورة، إن كانت مربوطة بمجلد خارجي
# (Volume) في بيئة الإنتاج.
COPY --from=build /app/plugins ./plugins

EXPOSE 4000
# يجب ضبط DATABASE_URL وJWT_ACCESS_SECRET وJWT_REFRESH_SECRET كمتغيرات بيئة عند التشغيل — لا قيم
# افتراضية هنا عمدًا. يُطبِّق الترحيلات أولًا (آمن عند إعادة التشغيل — تتخطى ما طُبِّق سابقًا)، ثم يبدأ الخادم.
# المسار dist/src/... لأن tsconfig.json يحافظ على بنية src/ داخل dist/ (rootDir: ".").
CMD ["sh", "-c", "node dist/src/db/migrate.js && node dist/src/server.js"]
