/**
 * نقطة دخول Vercel Serverless للباك إند (بديل مجاني لـ Render، بلا "نوم" طويل).
 * يتطلب أن يكون `npm run build` قد أنتج مجلد dist/ (يُنفَّذ تلقائيًا عبر buildCommand في vercel.json).
 * مسارات التوجيه (/api/*, /health, /plugin-assets/*) تُعاد كتابتها إلى هذه الدالة في vercel.json.
 */
const { createApp } = require('../dist/src/app');

module.exports = createApp();
