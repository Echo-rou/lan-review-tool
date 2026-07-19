@echo off
rem 安装依赖脚本（clone 后运行一次）—— GBK 编码
title 安装依赖 - 提审交付工具
echo ====================================
echo    提审交付工具 · 安装依赖
echo ====================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  需要 Node.js，请先到 https://nodejs.org 下载安装 LTS 版。
  echo  装好后重新双击本文件。
  pause
  exit /b 1
)
echo 正在安装主服务依赖...
cd /d "%~dp0server"
call npm install
if errorlevel 1 ( echo [错误] 主服务依赖安装失败！ & pause & exit /b 1 )
echo [OK] 主服务依赖安装完成
echo.
echo 正在安装接收端依赖...
cd /d "%~dp0receiver"
call npm install
if errorlevel 1 ( echo [错误] 接收端依赖安装失败！ & pause & exit /b 1 )
echo [OK] 接收端依赖安装完成
echo.
echo ====================================
echo   安装完毕！双击「启动创作者主机.bat」开始使用。
echo ====================================
pause
