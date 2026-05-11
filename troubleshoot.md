# Workbench Video Pipeline — Troubleshooting

在把视频工作台迁移到 Vercel + 本地 Kiro 混合架构过程中踩的坑。按类型组织，方便以后定位。

**最终架构**：

```
Brief/Storyboard/HTML  → 本地 Kiro + LLM (token 密集)
Audio (Azure TTS)      → Vercel 直跑 (纯 HTTP)
Render (HyperFrames)   → 本地 Mac + Metal GPU (M4 Pro 比云端快 3-5x)
展示 / 播放            → Vercel (从 Neon + Blob 读)
```

**数据流**：
- Neon: project/scene metadata + HTML content + 状态
- Vercel Blob: audio MP3 + output MP4
- `projects.video_blob_url` / `scenes.audio_blob_url` 保存云端资源 URL

---

## 1. Vercel 文件系统是只读的

### 症状

```
WRITE_FAILED: ENOENT: no such file or directory, mkdir '/var/task/data/projects'
```

随便做点什么涉及写文件的操作都会报这个错——生成音频、保存 project、写 log。

### 根本原因

Vercel serverless 的 `/var/task` 是只读文件系统。唯一可写目录是 `/tmp`（且跨 invocation 不持久化）。

workbench 的代码原本是**本地单人**架构，默认所有状态都走本地 FS（`writeProject` → `atomic-fs` → `mkdir` → `writeFile`）。

### 解决

在 `src/lib/env.ts` 里加 `isLocalEnv()` helper（检测 `process.env.VERCEL`），然后在每个写 FS 的地方分支：

```typescript
// src/lib/workbench/project-store.ts
export async function writeProject(project: Project): Promise<void> {
  if (!isLocalEnv()) {
    // Vercel: 直接写 Neon，跳过本地 FS
    await syncProjectToNeon(validated.data);
    return;
  }
  // 本地: 写文件后 fire-and-forget 同步 Neon
  await atomicWriteJson(absPath, validated.data, { spaces: 2 });
  // ...
}
```

同样处理：
- `writeAudioFile` → Vercel 上 put 到 Blob
- `createLogger` → Vercel 上返回 console-only logger
- `readProject` → Vercel 上从 Neon 读

---

## 2. 认为"必须本地跑"的其实不需要

### 症状

Audio tab 在 Vercel 上返回：

```json
{ "error": { "code": "LOCAL_ONLY", "message": "Audio generation requires local tools (Python/kiro-cli/HyperFrames)" } }
```

### 根本原因

最初的 `audio/generate` route 被 `localOnlyResponse` 无脑拦截，写错了。Azure TTS 是**纯 HTTP REST API**，完全不需要本地工具。原本的 "LOCAL_ONLY" 标签是因为 Python venv 里跑 Azure SDK + 写本地文件系统，但两个依赖都可以去掉。

### 诊断

复盘五个阶段对本地/LLM 的依赖：

| 阶段 | LLM | 本地工具 | 可在 Vercel 跑？ |
|------|-----|---------|-----------------|
| brief | ✅ Kiro | ❌ | ❌ 需本地 Kiro |
| storyboard | ✅ Kiro | ❌ | ❌ |
| composition | ✅ Kiro | ❌ | ❌ |
| **audio** | ❌ 纯 HTTP | ❌ | ✅ 可以跑！ |
| **render** | ❌ 纯计算 | ✅ (需要 Chrome + FFmpeg) | 可以但很慢 |

### 解决

- 去掉 `audio/generate` 的 `localOnlyResponse` 拦截
- `writeAudioFile` 分支：Vercel 上 put 到 Blob，返回 URL
- 前端 `<audio src>` 检测到 `https://` 直接用 URL，跳过内部 API

---

## 3. Vercel Blob 操作常见错误

### 3.1 "This blob already exists"

```
BlobError: This blob already exists, use 'allowOverwrite: true'
```

重新生成同一个 scene 时 `put()` 默认不允许覆盖。

```typescript
await put(path, buf, {
  access: "public",
  addRandomSuffix: false,
  allowOverwrite: true,  // ← 必加
});
```

### 3.2 HTTP 413 Payload Too Large

上传 10MB+ MP4 直接到 `/api/.../render/upload`：

```
HTTP 413 FUNCTION_PAYLOAD_TOO_LARGE
```

### 根本原因

Vercel serverless 的 body 限制是 **4.5MB**，无法通过 config 提高。`maxDuration` 和 body size 是两个独立限制。

### 解决

**客户端直传 Blob**——Kiro skill 在本地用 `@vercel/blob` SDK 直接 put 到 Blob（绕过 Vercel 函数），然后 POST 一个小 JSON 只带 URL 到 callback route：

```javascript
// 本地 Kiro 里跑（用 BLOB_READ_WRITE_TOKEN）
const { put } = require('@vercel/blob');
const { url } = await put('video/{projectId}/output.mp4', buf, {
  access: 'public',
  token: BLOB_READ_WRITE_TOKEN,
  allowOverwrite: true,
});

// 然后只发 URL 到 callback
await fetch('/api/projects/.../render/upload', {
  method: 'POST',
  body: JSON.stringify({ videoBlobUrl: url, sizeBytes: buf.length }),
});
```

`BLOB_READ_WRITE_TOKEN` 从 `vercel env pull --environment=production` 拿，然后保存到本地 `.env.local`。

### 3.3 环境变量不传

```bash
# 错：直接跑会拿不到 token
node -e "..."

# 对：显式传给 node 进程
BLOB_READ_WRITE_TOKEN=$BLOB_TOKEN node -e "..."
# 或者在 SDK 调用里显式传
await put(..., { token: $BLOB_TOKEN });
```

---

## 4. 前端"项目不存在"误报

### 症状

Vercel 上打开 `/projects/{id}` 显示"项目不存在或无法读取"，但 Neon 里 project 数据完好。

### 根本原因

`readProject` 从 Neon 读回数据后用 zod 校验，某个脏数据导致失败。具体是我们手动修 Neon 时写了 `stage_status.render.status = "not_started"`，但 schema 只认 `pending/running/succeeded/failed/skipped`。

### 解决

在 `readProject` 的 `filterStageStatus` 里加一层防御：

```typescript
function filterStageStatus(raw: unknown): unknown {
  const validStages = new Set(["brief", "storyboard", "composition", "audio", "render"]);
  const validStatuses = new Set(["pending", "running", "succeeded", "failed", "skipped"]);
  return Object.fromEntries(
    Object.entries(raw).filter(([k]) => validStages.has(k))
      .map(([k, v]) => {
        if (v?.status && !validStatuses.has(v.status)) {
          return [k, { ...v, status: "pending" }]; // fallback
        }
        return [k, v];
      })
  );
}
```

---

## 5. HyperFrames Render 的大坑：sub-composition seek bug

**这是这次最大的坑，花了几个小时定位。**

### 症状

- `npx hyperframes render` 正常退出，无错误
- MP4 生成成功（正确时长、正确 fps、正确分辨率）
- 但画面几乎是**静态**的——抽任意时间点的帧，只有 2-3 种不同 hash
- 在浏览器直接打开 HTML 播放动画**完全正常**

### 诊断过程

1. **帧对比**：`ffmpeg -ss N -frames:v 1` 抽不同时间点，发现只有两种 hash 交替。起初以为是 ffmpeg 抽帧问题，抽全帧序列确认。

2. **Debug 页面**：写了个独立 HTML + http.server，手动用 `tl.seek(t)` 触发 timeline。浏览器里**动画完全正常**。证明 HTML 本身没问题。

3. **Render warning 日志**：render 过程中大量 `GSAP target not found` 警告。

4. **Inline 对比**：把 scene-02 的 `<template>` 内容直接 inline 到 index.html（去掉 `data-composition-src` 机制）。Render 结果：**9 个时间点 9 个不同 hash**。问题定位到 sub-composition 机制。

### 根本原因

HyperFrames 0.5.5 的 `data-composition-src` 自动 nest 机制在 render pipeline 里**不能正确把 parent timeline 的 seek 传递到子 timeline**。浏览器 preview 模式正常（用 `gsap.ticker` 驱动），但 render 模式用的是 `timeline.seek(t)` 逐帧捕获，子 timeline 保持在 t=0 不动。

相关规则（在 `hyperframes` 官方 skill 里）：

> **Rule #10 (Non-Negotiable)**: Use `gsap.set()` on clip elements from later scenes — they don't exist in the DOM at page load. Use `tl.set(selector, vars, timePosition)` inside the timeline at or after the clip's `data-start` time instead.

但即使我完全遵守这个规则，sub-composition 的 seek 还是不传。

### 解决

写了 `scripts/merge-scenes-for-render.mjs`——把所有 scene 的 `<template>` 内容 **inline** 到一个大 index.html，所有 scene 的 timeline 通过 `__master.add(tl_sNN, offset)` 加到一个 master timeline。render 直接 seek master。

关键代码：

```javascript
// 每个 scene script:
//   const tl = gsap.timeline({ paused: true })
// 改写为:
//   const tl_s00 = gsap.timeline({ })           // 不 paused!
//   tl_s00.fromTo(...)
//   // 不再 window.__timelines['...'] = tl
// 最外层 master:
const __master = gsap.timeline({ paused: true });
__master.add(tl_s00, 0);
__master.add(tl_s01, 10);
// ...
window.__timelines['main'] = __master;
```

**重要细节**：
- 子 timeline **不能 paused**（否则 master seek 不会 propagate）
- master 必须 paused（hyperframes 要求）
- 必须移除原 scene script 里的 `window.__timelines[...] = tl` 那行（因为 `tl` 已经被 rename 成 `tl_sNN`，旧代码会 `ReferenceError`）

---

## 6. Merge 后 scene 画面残留 / 相互覆盖

### 症状

Merge 完成后，前几个 scene 正常，但 scene-4/7/9 的时间窗口里，画面是**前一个 scene 的残留**或**空白**。

### 诊断

最开始怀疑是 scene script 里的 `const state = {...}` 变量冲突——不是，IIFE 隔离了作用域。

后来发现 merge script 里保留了原 scene 的 `window.__timelines['scene-XX'] = tl` 这一行，但 `tl` 已经被改成 `tl_sNN`，所以这行 `ReferenceError`。这个 throw 后面的 `__master.add(tl_sNN, offset)` 不会执行——**scene 的 timeline 没加到 master**，所以该 scene 的动画完全不播。

更深的问题：即使修了 ReferenceError，还是有残留。原因是用 `opacity: 0 / visibility: hidden` 控制 scene 可见性，被**子 scene 的 opacity tween 污染了**——scene-4 内部有 `tl.fromTo('.s04-bg', opacity: 0, opacity: 1)`，GSAP 把 scene-4 的 opacity 设成 1 后，因为浏览器的 opacity 继承，前一个 scene 也跟着变显示。

### 解决

两处修：

**1. 清理残留的 timeline 赋值**：

```javascript
// merge-scenes-for-render.mjs
.replace(/window\.__timelines\s*\[[^\]]+\]\s*=\s*[a-zA-Z_$][\w$]*\s*;?/g, "")
```

正则匹配**所有** `window.__timelines[...] = anyVar;` 写入并删除（不管变量名是 `tl` 还是 `tl_sNN`）。

**2. 用 `display: none / block` 代替 `opacity: visibility`**：

```javascript
// 每个 scene 的可见性通过 display 控制
__master.set(sceneSelector, { display: 'none' }, 0);
__master.set(sceneSelector, { display: 'block' }, startTime);
__master.set(sceneSelector, { display: 'none' }, endTime);
```

`display: none` 彻底移除元素的 layout 和 paint，子元素的 opacity tween 无法作用。

**注意**：不要用 `.call()`！GSAP 的 `.call()` 是"播放到这个时间点时触发 callback"，render 的 `seek()` 模式**不会触发 callback**，所以可见性必须用 `.set()` 做。

---

## 7. HyperFrames Sub-composition 的 GSAP 规则

### 症状

Scene HTML 在浏览器里播放正常，但 render 出来是全黑或动画不触发。

### 根本原因 + 规则

在 sub-composition HTML 里：

| ❌ 错误 | ✅ 正确 |
|--------|--------|
| `gsap.set(selector, {...})` 在脚本顶层 | `tl.set(selector, {...}, 0)` 放 timeline 里 |
| `tl.from(selector, {...}, t)` | `tl.fromTo(selector, fromVars, toVars, t)` |
| `gsap.timeline()` 不 paused | `gsap.timeline({ paused: true })` |
| `paused: -1` 或无限 yoyo | 有限次 `repeat: N` |

官方 `hyperframes` skill 里的 **Rule #10**：

> Use `gsap.set()` on clip elements from later scenes — they don't exist in the DOM at page load.

规则解读：sub-composition 的 DOM 元素在 page load 时还**没挂载**（hyperframes runtime 延迟加载），所以顶层 `gsap.set/from/to` 查找 selector 会返回 `null`，静默失败。必须所有状态变更都排进 timeline，由 timeline seek 时执行。

### 修复脚本

写了 `scripts/fix-scene-from-to-fromto.mjs` 做批量 `tl.from()` → `tl.fromTo()` 转换，自动推断 rest state（opacity:0 → 1, y:40 → 0 等）。

---

## 8. Vercel 部署问题

### 8.1 push 不触发自动部署

- **原因**：Vercel 项目没连接 GitHub repo（只连了 GitLab）
- **临时解决**：每次手动 `npx vercel --prod --yes`
- **正确解决**：在 Vercel Dashboard 连接 GitHub（需要在 Web UI 操作，CLI 做不到）

### 8.2 `rootDirectory` 设置

Vercel 项目的 `rootDirectory`：
- **null**：从仓库根目录 deploy。从 `web/` 子目录跑 `vercel --prod` 会打包 `web/` 里所有内容
- **`web`**：告诉 Vercel 视 `web/` 为根。必须从仓库**根目录**跑 `vercel --prod`（从 `web/` 跑会变成 `web/web` 失败）

**选 null + 从 `web/` 目录 push** 最简单，不用解释 root 概念。

### 8.3 alias 漂移

部署完 `vercel --prod` 后，生产 alias 不自动更新。要手动：

```bash
npx vercel alias set <latest-deployment>.vercel.app web-dale-vercel.vercel.app
```

---

## 9. 视频质量的"软"问题

### 症状

- HTML 通过 lint，render 成功
- 但视觉效果差：黑屏占 95%、元素稀疏、stroke 太细、字太小、动画只有淡入

### 根本原因

LLM 生成的 HTML 擅长满足"lint pass"这种机械指标，但不懂**视频制作的视觉密度要求**。默认生成的东西像是"web 网页的黑暗模式"，不是"视频帧"。

### 解决方向

1. **手写关键场景**做审美锚点（第一个 scene 做 pilot），复制风格到其他 scene
2. 视觉检查清单：
   - 背景亮度占屏 > 5%（不要全黑）
   - 主标题 ≥ 100px，副标题 ≥ 30px，数据 ≥ 20px
   - 每个元素有 stroke/glow/shadow 之一增加存在感
   - 每个 scene 至少 3 种节奏变化（快进 / 慢拉 / 强调 pulse）
   - cos/sin/tan 等概念性元素用**一致的颜色编码**（琥珀 / 品红 / 青 / 紫）
3. 参考 `hyperframes` skill 的 `references/video-composition.md` 和 `references/motion-principles.md`

**workbench-compose 的 LLM 提示词** 需要明确包含这些视觉规则才不会生成"web 风格"的 HTML。当前 skill 里已经有 hard-gate，但生成质量还是不稳定。

---

## 10. 小坑清单

- **`npm install @vercel/blob`** 必需，`@vercel/sandbox` 可以卸（最终没用 Sandbox 方案）
- **`.env.local` 里的 BLOB_READ_WRITE_TOKEN** 从 `vercel env pull --environment=production` 拉，每个 Blob store 独立 token
- **HyperFrames `--gpu` flag**：M4 Pro 一定要加，启用 VideoToolbox 硬件编码，render 能快 2-3 倍
- **HyperFrames `--workers auto`**：默认 4 个 Chrome worker 并行截图，别改
- **hyperframes lint 警告 "multiple_root_compositions"**：删掉 `index.prev.html.bak` 和 `preview-*.html` 临时文件
- **Neon schema 里 video_blob_url 和 artifacts.videoPath 冗余**：两个都写以防万一，前端 fallback 读 `artifacts.videoPath`
- **前端 `<audio src>`**：如果是 https URL 直接用，相对路径才走 API route
- **`.gitignore` 漏掉** `workbench-data/**/frames/`、`preview-*/` 等临时文件目录，会误 commit 几千张 PNG

---

## 最终可用的命令

### 本地 render 完整项目

```bash
# 1. Merge 所有 scene 到 index.html
node scripts/merge-scenes-for-render.mjs \
  workbench-data/projects/<id>/composition \
  workbench-data/projects/<id>/composition/index.html

# 2. Render
cd workbench-data/projects/<id>/composition
npx --yes hyperframes@0.5.5 render \
  --output output.mp4 \
  --quality standard \
  --workers auto \
  --gpu
```

### 上传 MP4 到 Vercel

```bash
BLOB_TOKEN=$(grep '^BLOB_READ_WRITE_TOKEN' web/.env.local | cut -d= -f2- | tr -d '"')
WB_TOKEN=$(cat ~/.kiro/settings/workbench-render.env | grep WORKBENCH_RENDER_TOKEN | cut -d= -f2)

node -e "
const fs = require('fs');
const { put } = require('@vercel/blob');
const buf = fs.readFileSync('path/to/output.mp4');
(async () => {
  const { url } = await put('video/<id>/output.mp4', buf, {
    access: 'public',
    contentType: 'video/mp4',
    addRandomSuffix: false,
    allowOverwrite: true,
    token: '$BLOB_TOKEN',
  });
  await fetch('https://web-dale-vercel.vercel.app/api/projects/<id>/render/upload', {
    method: 'POST',
    headers: {'Content-Type':'application/json','x-workbench-render-token':'$WB_TOKEN'},
    body: JSON.stringify({ videoBlobUrl: url, sizeBytes: buf.length }),
  });
})();
"
```

### 诊断 render 有没有真跑

```bash
# 抽不同时间点的帧，hash 应该都不同
for t in 0 10 20 30 40 50 60 70 80 90 100; do
  ffmpeg -y -i output.mp4 -ss $t -frames:v 1 /tmp/f_${t}.png -loglevel error
  echo "t=${t}s $(md5 -q /tmp/f_${t}.png | head -c 8)"
done
```

如果 hash 高度重复 → sub-composition seek 没生效，重新跑 merge 脚本并检查有没有 `window.__timelines[...] = tl` 残留。
