@echo off
REM بناء ملف CobraTex-Setup.exe على ويندوز (يحتاج Node 22+ فقط). النتيجة في desktop\release
setlocal
cd /d "%~dp0"
echo [1/3] تثبيت مكتبات سطح المكتب (تشمل Electron وPostgreSQL المضمَّن)...
call npm install || goto :fail
echo [2/3] بناء الباك إند والواجهة وتجهيز الحزمة...
call npm run prepare:payload || goto :fail
echo [3/3] تغليف الـ exe...
call npx electron-builder --win --x64 || goto :fail
echo.
echo تم. الملفات في: %cd%\release
dir /b release\*.exe
exit /b 0
:fail
echo فشلت الخطوة السابقة.
exit /b 1
