@echo off
rem 创作者主机启动器（GBK 编码保存，cmd 中文可直接解析）
title 提审交付工具 - 创作者主机
cd /d "%~dp0server"
if errorlevel 1 (
  echo [错误] 找不到 server 文件夹，请确认本文件放在项目根目录下。
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  这台电脑还没有安装 Node.js 运行环境。
  echo  请先安装：打开 https://nodejs.org 下载 LTS 版，一路点"下一步"即可。
  echo  装好后重新双击本文件。
  echo.
  start "" "https://nodejs.org/zh-cn/download"
  pause
  exit /b 1
)
if not exist "src\server.js" (
  echo [错误] 找不到 src\server.js，项目文件可能不完整。
  pause
  exit /b 1
)
echo 正在启动创作者主服务，浏览器会自动打开创作者页面...
echo （这个黑色窗口需要一直开着，关掉它服务就停了）
node src\server.js
echo.
echo 服务已停止。
pause
