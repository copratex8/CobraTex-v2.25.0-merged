// إضافة توضيحية — ملف JavaScript عادي بلا أي خطوة تجميع (لا tsc، لا ts-node يُلزَمها التحقق).
// أُسقِط هذا المجلد كاملًا داخل plugins/ وأُعِد تشغيل عملية الخادم (لا إعادة بناء/تغليف) ليظهر.
//
// يثبت: (أ) تسجيل مسار API جديد بالكامل، (ب) الوصول لقاعدة البيانات المشتركة عبر sdk.pool،
// (ج) توفر req.ctx (هوية المستخدم/الشركة/الفرع) تلقائيًا لأن الإضافة تُحمَّل بعد authMiddleware.

module.exports = {
  registerRoutes(router, sdk) {
    router.get('/plugins/hello-activity/ping', (req, res) => {
      res.json({
        message: 'مرحبًا من نشاط خارجي (plugin) — لم يُعدَّل أي كود أساسي في المشروع لإضافة هذا المسار.',
        loadedAt: new Date().toISOString(),
        calledBy: req.ctx ? req.ctx.userId : null,
      });
    });

    router.get('/plugins/hello-activity/company-info', async (req, res, next) => {
      try {
        const result = await sdk.pool.query(
          'SELECT legal_name, base_currency_code FROM companies WHERE id=$1',
          [req.ctx.companyId],
        );
        res.json({ company: result.rows[0] ?? null, source: 'hello-activity plugin' });
      } catch (err) {
        next(err);
      }
    });
  },
};
