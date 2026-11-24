@echo off
if not defined WGC_VCVARS set "WGC_VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
call "%WGC_VCVARS%" x64
if errorlevel 1 exit /b 1
set "SDK_INCLUDE=%WindowsSdkDir%Include\%WindowsSDKVersion%cppwinrt"
set "INCLUDE=%SDK_INCLUDE%;%INCLUDE%"
mkdir "%~dp0bin" 2>nul
cl /nologo /std:c++20 /EHsc /O2 /permissive- /DUNICODE /D_UNICODE "%~dp0wgc_capture.cpp" /Fe:"%~dp0bin\wgc-capture.exe" /Fo:"%~dp0bin\wgc_capture.obj" /link /SUBSYSTEM:CONSOLE /MACHINE:X64 WindowsApp.lib d3d11.lib dxgi.lib dwmapi.lib windowscodecs.lib ole32.lib oleaut32.lib user32.lib
if errorlevel 1 exit /b 1
echo WGC_CAPTURE_OK %~dp0bin\wgc-capture.exe
