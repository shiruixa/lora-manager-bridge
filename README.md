# LoRA Manager Bridge

浏览 CivitAI / CivArchive 时，自动标记哪些模型已经在你的本地 ComfyUI LoRA Manager 库中。

支持 LoRA 和 Checkpoint 两种模型类型。

## 功能

- **模型详情页** — 标题旁显示状态：✅ 已下载 / ⚠️ 有其他版本 / 📥 不在库中
- **版本切换** — 自动检测选中的版本是否已下载
- **版本列表** — 可展开查看所有已下载版本，当前版本高亮标记
- **列表页** — 模型卡片右上角绿色 ✅ 角标
- **懒加载** — 滚动加载新卡片时自动扫描
- **多站点支持** — civitai.com、civitai.red、civitaiarchive.com

## 支持的站点

| 站点 | 页面 | 功能 |
|------|------|------|
| [civitai.com](https://civitai.com) | 模型列表、搜索、详情页 | ✅ 标记 + 详情徽章 |
| [civitai.red](https://civitai.red) | 同上（CivitAI 镜像） | ✅ 标记 + 详情徽章 |
| [civitaiarchive.com](https://civitaiarchive.com) | 模型列表、用户主页、详情页 | ✅ 标记 + 详情徽章 |

CivArchive 是 CivitAI 的存档镜像站，复用同一套模型/版本 ID 体系，因此标记逻辑完全通用。

## 安装

1. 打开 `edge://extensions`（或 `chrome://extensions`）
2. 启用 **开发人员模式**
3. 点击 **加载解压缩的扩展**
4. 选择 `lora-manager-edge-extension` 目录
5. 点击扩展图标 → ⚙️ 设置 → 配置 ComfyUI 地址

## 要求

- Edge 120+ 或 Chrome 120+
- ComfyUI 已安装 [LoRA Manager](https://github.com/willmiao/ComfyUI-Lora-Manager) 插件
- ComfyUI 服务器正在运行（默认 `http://127.0.0.1:8188`，可在设置中修改）

## 开发

```
lora-manager-edge-extension/
├── manifest.json          # Manifest V3
├── background.js          # Service Worker
├── content-script.js      # 页面注入脚本（含 CivArchive DOM 适配）
├── content-style.css      # 注入样式
├── popup.html/js/css      # 工具栏弹窗
└── options.html/js/css    # 设置页面
```

纯 JavaScript，无构建步骤。修改后到扩展管理页面点"重新加载"即可生效。

## 版本历史

- **v1.1.1** — Bug 修复与优化：ComfyUI 离线时正确提示「未连接」（此前误报「不在库中」）；批量请求失败后自动重试（此前卡片永久漏标）；并发上限真正生效；弹窗刷新改为就地重扫（不重载页面）；深/浅主题适配
- **v1.1.0** — 支持 CivArchive（civitaiarchive.com）
- **v1.0.0** — 初代发布：详情页标记、版本切换、列表页批量标记、LoRA+Checkpoint 双查
