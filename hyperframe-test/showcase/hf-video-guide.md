# HyperFrames 视频制作指南

> 基于 showcase 项目实战总结。HyperFrames v0.5.7 · Node 22 · macOS

---

## 一、项目结构

```
my-video/
├── index.html              # 主 composition（根时间线）
├── compositions/           # 子 composition（可选）
├── assets/                 # 媒体文件（视频/音频/图片）
├── renders/                # 渲染输出
├── hyperframes.json        # 项目配置
└── package.json            # scripts: dev / check / render
```

---

## 二、制作流程

### Step 1: 脚手架

```bash
npx hyperframes init my-video --example blank --non-interactive
cd my-video
```

### Step 2: 设计系统（可选）

创建 `design.md` 定义调色板、字体、圆角等品牌规范。没有的话 HyperFrames 会用 house-style 默认值。

### Step 3: 规划场景节奏

在写 HTML 之前先确定：
- 总时长、场景数量
- 每个场景的时间窗口
- 转场类型（shutter / crossfade / wipe）
- 动画节奏模式（fast-fast-SLOW-fast 等）

### Step 4: 写 HTML

核心原则：**先布局，再动画**。

1. 把每个场景的"最终可见状态"写成静态 HTML+CSS
2. 确认布局无重叠后，再加 GSAP 入场动画

### Step 5: 验证

```bash
npx hyperframes lint          # 结构检查
npx hyperframes validate      # schema + 对比度
npx hyperframes inspect       # 布局溢出检测
```

### Step 6: 预览

```bash
npx hyperframes preview       # 浏览器热重载
```

### Step 7: 渲染

```bash
npx hyperframes render --quality draft --fps 24    # 快速迭代
npx hyperframes render --quality standard --fps 30 # 正式输出
npx hyperframes render --quality high --fps 60     # 最终交付
```

---

## 三、核心概念速查

### 数据属性

| 属性 | 说明 |
|------|------|
| `data-composition-id` | 唯一标识，必须与 `window.__timelines[id]` 对应 |
| `data-start` | 开始时间（秒），**相对于根 composition 的绝对时间** |
| `data-duration` | 持续时间（秒） |
| `data-track-index` | 轨道索引，同轨道不可重叠 |
| `data-width` / `data-height` | 画布尺寸（通常 1920×1080） |

### 时间线注册

```js
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
// ... tweens ...
window.__timelines["main"] = tl;
```

### 场景可见性

带 `class="clip"` 的元素只在 `data-start` ~ `data-start + data-duration` 期间可见。**所有有 data-start 的元素必须加 `class="clip"`**。

---

## 四、踩坑记录 & 解决方案

### 坑 1: `data-start` 是绝对时间

**现象**：子元素 `data-start="0.2"` 导致它在第 0.2 秒就出现，而不是等父场景开始后 0.2 秒。

**原因**：HyperFrames 的 `data-start` 始终是相对于根 composition 的绝对秒数，不是相对于父元素。

**解决**：手动计算绝对时间。如果场景从 4.8s 开始，子元素想延迟 0.2s 出现，就写 `data-start="5.0"`。

---

### 坑 2: Sub-composition 变量读取失败

**现象**：通过 `data-composition-src` 加载的子 composition 里调用 `window.__hyperframes.getVariables()` 返回的是根 composition 的变量，不是宿主元素的 `data-variable-values`。

**原因**：子 composition 的 JS 运行在编译器注入的隔离 DOM 环境中，`document.currentScript.parentElement` 向上遍历找不到宿主元素。`getVariables()` 返回的是根级声明的变量。

**解决方案（推荐）**：对于需要不同数据的重复组件，**直接 inline 到主 composition**，用 JS 循环或手写多份 HTML，在同一个 timeline 里驱动动画。

**何时用 sub-composition**：
- ✅ 场景级别的拆分（每个场景一个文件，降低单文件复杂度）
- ✅ 不需要外部变量的独立动画模块
- ❌ 需要 per-instance 不同数据的可复用卡片（用 inline 代替）

---

### 坑 3: 缺少 `class="clip"` 导致元素全程可见

**现象**：场景 2 的卡片在场景 1 期间就显示了。

**原因**：有 `data-start` / `data-duration` 但没加 `class="clip"`，HyperFrames 不会自动隐藏它。

**解决**：所有带时间属性的元素必须加 `class="clip"`。

---

### 坑 4: 同轨道重叠

**现象**：lint 报 `overlapping_clips_same_track` 错误。

**原因**：多个元素的 `data-track-index` 相同，且时间窗口有交集。

**解决**：给并行显示的元素分配不同的 `data-track-index`。注意 track-index 不影响视觉层级（用 CSS `z-index` 控制）。

---

### 坑 5: `Math.ceil` 导致 repeat 超出 duration

**现象**：lint 警告 `gsap_repeat_ceil_overshoot`。

**原因**：`repeat: Math.ceil(duration / cycle) - 1` 可能让动画总时长超过 composition duration。

**解决**：用 `Math.floor` 代替 `Math.ceil`：
```js
repeat: Math.max(0, Math.floor(totalDuration / cycleDuration) - 1)
```

---

### 坑 6: `validate` 的 WCAG 对比度误报

**现象**：validate 报大量 contrast warning，但实际视频里对比度正常。

**原因**：validate 在固定时间点截图采样所有 DOM 元素的文字颜色 vs 背景色。被 `.clip` 隐藏的场景内容仍在 DOM 中，采样时它们的文字被对比到了错误的背景上。

**解决**：这是已知的 false positive。确认 warning 都来自"非当前可见场景"的元素即可忽略。真正需要修的是当前场景内的对比度问题。

---

## 五、动画最佳实践

### 转场规则（强制）

1. **必须有转场**，不允许硬切
2. **只有入场动画**（`gsap.from()`），转场本身就是出场
3. **不要在非最后一个场景写退出动画**（`gsap.to(..., {opacity: 0})`）
4. 最后一个场景可以 fade out

### 入场动画模板

```js
// 标题从下方滑入
tl.from("#title", { y: 50, opacity: 0, duration: 0.6, ease: "power3.out" }, 0.3);
// 副标题跟随
tl.from("#subtitle", { y: 30, opacity: 0, duration: 0.5, ease: "power2.out" }, 0.5);
// 图标弹性缩放
tl.from("#icon", { scale: 0.5, opacity: 0, duration: 0.5, ease: "elastic.out(1, 0.6)" }, 0.4);
```

### Shutter 转场模板

```js
// 关闭（遮住旧场景）
tl.fromTo("#sh-top", { scaleY: 0 }, { scaleY: 1, duration: 0.3, ease: "power3.in" }, exitTime);
tl.fromTo("#sh-bot", { scaleY: 0 }, { scaleY: 1, duration: 0.3, ease: "power3.in" }, exitTime);
// 打开（露出新场景）
tl.to("#sh-top", { scaleY: 0, duration: 0.38, ease: "power3.out" }, exitTime + 0.34);
tl.to("#sh-bot", { scaleY: 0, duration: 0.38, ease: "power3.out" }, exitTime + 0.34);
```

### 数字计数器模板

```js
const counter = { v: 0 };
tl.to(counter, {
  v: targetValue,
  duration: 1.5,
  ease: "power2.out",
  onUpdate() { el.textContent = Math.round(counter.v); },
}, startTime);
```

### 进度条模板

```js
tl.to(fillEl, { width: target + "%", duration: 1.0, ease: "expo.out" }, startTime);
```

---

## 六、禁止事项

| ❌ 不要 | ✅ 应该 |
|---------|---------|
| `Math.random()` / `Date.now()` | 用 seeded PRNG 或固定值 |
| `repeat: -1` | 计算有限 repeat 次数 |
| 在 async/setTimeout 里建 timeline | 同步构建 timeline |
| 动画 `visibility` / `display` | 动画 `opacity` / `transform` |
| 调用 `video.play()` / `audio.play()` | 让框架管理媒体播放 |
| 用 `<br>` 强制换行 | 用 `max-width` 让文字自然换行 |
| 全屏线性渐变（暗背景） | 用径向渐变或纯色 + 局部光晕 |

---

## 七、CLI 命令速查

```bash
npx hyperframes init <name>       # 创建项目
npx hyperframes lint              # 结构检查
npx hyperframes validate          # schema + 对比度
npx hyperframes inspect           # 布局溢出
npx hyperframes preview           # 浏览器预览（热重载）
npx hyperframes render            # 渲染 MP4
npx hyperframes render --variables '{"key":"val"}'  # 参数化渲染
npx hyperframes doctor            # 环境诊断
```

---

## 八、参数化渲染（Variables）

在 `<html>` 上声明变量：
```html
<html data-composition-variables='[
  {"id":"title","type":"string","label":"Title","default":"Hello"},
  {"id":"accent","type":"color","label":"Accent","default":"#d97706"}
]'>
```

脚本中读取：
```js
const vars = window.__hyperframes.getVariables();
// 或 fallback（validate 环境下 getVariables 可能不存在）：
function readVars() {
  try { return window.__hyperframes.getVariables(); } catch(e) {}
  const raw = document.documentElement.getAttribute("data-composition-variables");
  if (raw) {
    const decls = JSON.parse(raw);
    return Object.fromEntries(decls.map(d => [d.id, d.default]));
  }
  return {};
}
```

CLI 覆盖：
```bash
npx hyperframes render --variables '{"title":"Q4 Report","accent":"#10b981"}'
```

---

## 九、本次 Showcase 项目参数

- 总时长：22 秒
- 分辨率：1920×1080 @ 30fps
- 场景数：5（kinetic title → inline cards → data viz → code typing → logo outro）
- 转场：shutter（scaleY 开合）
- 输出：`renders/showcase.mp4`（2.9 MB）
- 渲染耗时：~11 秒（M4 Pro, 14 cores, GPU hardware）
