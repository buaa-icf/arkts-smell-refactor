@echo off
setlocal EnableExtensions DisableDelayedExpansion
"%SystemRoot%\System32\chcp.com" 65001 >nul
echo ArkTS Skill - Windows installer
echo.

node.exe --version >nul 2>&1
if errorlevel 1 goto missing_node
node.exe -e "var v=process.versions.node.split('.'); process.exit(Number(v[0])>20 || (Number(v[0])===20 && Number(v[1])>=19) ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto old_node

node.exe "%~dp0scripts\install-windows.mjs" %*
set "ARKTS_INSTALL_EXIT=%ERRORLEVEL%"
goto finish

:missing_node
echo [ERROR] 未找到可运行的 Node.js。
echo 请安装 Node.js 20.19 或更高版本，并将 node 加入 PATH，然后重新双击此文件。
echo 下载地址：https://nodejs.org/
set "ARKTS_INSTALL_EXIT=3"
goto finish

:old_node
echo [ERROR] Node.js 版本过低，需要 20.19 或更高版本。
echo 请升级 Node.js 后重新双击此文件。
set "ARKTS_INSTALL_EXIT=3"

:finish
if /I "%~1"=="--no-pause" exit /b %ARKTS_INSTALL_EXIT%
echo.
echo 按任意键关闭此窗口。
pause >nul
exit /b %ARKTS_INSTALL_EXIT%
