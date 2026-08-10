# NutriTrack PWA

个人使用的 iPhone 营养记录 PWA。

## 当前功能
- 每日热量、蛋白质、碳水、脂肪、膳食纤维统计
- 自定义每日目标
- 早餐 / 午餐 / 晚餐 / 加餐记录
- 手动添加食品
- 从相册选择营养成分表截图
- 浏览器端 OCR（Tesseract.js）
- kcal / kJ 基础解析
- 每 100g / 每份换算
- 本地保存（localStorage）
- PWA 安装与基础离线 App Shell

## 如何运行
PWA 需要通过 HTTPS 或 localhost 访问，不能直接双击 index.html 安装。

最简单：把整个文件夹部署到任意静态 HTTPS 托管（GitHub Pages / Cloudflare Pages / Netlify / Vercel 均可）。
然后在 iPhone Safari 打开网址 -> 分享 -> 添加到主屏幕。

## 注意
OCR 使用 Tesseract.js CDN。首次识别时需要联网加载 OCR 库/模型。记录数据默认仅保存在当前浏览器本地。
