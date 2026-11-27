# 中考复习 · GitHub Pages 站点

这是从单文件 `index.html` 拆分优化而来的静态站点，可直接部署到 GitHub Pages。

## 部署方式

1. 将本文件夹内**全部内容**上传到 GitHub 仓库（例如 `your-repo`）
2. 在仓库 Settings → Pages 中选择 `Deploy from a branch` → `main` / `/(root)`
3. 访问 `https://<用户名>.github.io/<仓库名>/`

> `.nojekyll` 文件已包含，可避免 Jekyll 忽略带下划线的资源。

## 目录结构

```
.
├── index.html              页面骨架（12 KB）
├── .nojekyll               GitHub Pages 配置
├── assets/
│   ├── css/style.css       全部样式（41 KB）
│   ├── js/app.js           全部逻辑与结构化数据（3.9 MB）
│   └── images/
│       ├── questions/      题目配图（WebP，去重）
│       ├── content/        知识点配图（WebP）
│       ├── notes/          手写笔记图片（WebP）
│       └── web/            网络配图（预留）
```

## 优化说明

- 原单文件 51.1 MB → 优化后约 14 MB（减少约 72%）
- 1375 处 base64 图片提取为 1360 个独立 WebP 文件（去重 13 个重复图片）
- 所有图片使用 `loading="lazy"` 懒加载
- CSS / JS 独立文件，浏览器可长期缓存
- 页面内容与交互功能与原单文件版本完全一致

## 独立白板模块

导航栏的「🎨 白板」按钮进入 `whiteboard.html`，顶部「← 返回复习」或 `Esc` 退出。

白板与文章批注在三个维度完全隔离：

| 维度 | 文章批注 | 独立白板 |
|---|---|---|
| 入口 | 底部「临时标注」工具栏 | 导航栏「白板」→ 独立页面 |
| 界面 | `annotation-*` DOM / 画布 | `wb-*` DOM / 独立画布与工具栏 |
| 数据 | 内存会话（刷新即清空） | 独立 localStorage 键 `zk_whiteboard_v1` |

功能：画笔绘制（压感/贝塞尔平滑）、文字批注、擦除、撤销、清空、颜色与粗细调节。

底层绘图算法抽取为 `assets/js/ink-core.js`（无 DOM、无状态、无存储的纯能力层），白板通过它复用与批注同源的压感曲线与平滑算法；白板自身状态封装在 `assets/js/whiteboard.js` 的 `WB` 对象中，不引用批注模块的任何变量或 DOM。
