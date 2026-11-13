# الإضافات

**إضافات الواجهة** (مستخلصة من نظام الهدى): ملف `.js` في `frontend/public/plugins/` + سطر في `manifest.json` (`{ "file": "x.plugin.js", "version": "1.0.0" }`). ارفع `version` عند التحديث، و`enabled:false` للتعطيل. لا بناء ولا تعديل كود. أمثلة: `quick-calc.plugin.js` و`system-pulse.plugin.js`.
```js
const plugin = { id:'my-plugin', name:'اسمي', section:{ group:'extensions', icon:'🧩' },
  mount(container, ctx) { /* ctx.api (axios مصادَق) , ctx.toast , ctx.brand , ctx.navigate */ container.innerHTML = '...'; } };
window.CobraTex?.registerPlugin(plugin); export default plugin;
```
تظهر تلقائيًا في الشريط الجانبي على المسار `/ext/<id>`. أصناف الواجهة الجاهزة: `card, kpi, fg/fc, btn-*, sum-bar, badge, etbl`.

**إضافات الخادم** (من جي تك): مجلد في `backend/plugins/<name>/` (`plugin.json` + `index.js` + اختياري `frontend/entry.js`). مثال: `hello-activity`. تظهر في صفحة «الإضافات». أعد تشغيل الخادم بعد الإضافة.
