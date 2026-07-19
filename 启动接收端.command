#!/bin/bash
# macOS 双击启动：接收端
cd "$(dirname "$0")/receiver"
if ! command -v node >/dev/null 2>&1; then
  echo "这台电脑还没有安装 Node.js。"
  echo "请打开 https://nodejs.org 下载 LTS 版安装，然后再双击本文件。"
  open "https://nodejs.org/zh-cn/download"
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi
echo "正在启动接收端，浏览器会自动打开接收页面..."
echo "（这个窗口需要一直开着）"
node src/receiver.js
