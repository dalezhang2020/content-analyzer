# Workbench Project Data

本目录存放视频创作工作台（`web/src/app/projects/`）生成的**项目数据**。
刻意放在 `web/` 外，与源代码隔离，方便备份和管理。

## 目录布局

```
workbench-data/
├── README.md                       ← 本文件
└── projects/                       ← 所有项目的根目录
    ├── {projectId}.json            ← 项目元数据 + 状态机（~8 KB）
    └── {projectId}/
        ├── brief.json              ← LLM 生成的 Brief
        ├── storyboard.json         ← LLM 生成的分镜
        ├── composition/            ← HyperFrames 模板副本（每项目一份）
        │   ├── index.html          ← LLM 生成的场景 HTML
        │   ├── index.failed.html   ← lint 失败的历史副本（调试用）
        │   ├── hyperframes.json    ← 模板配置
        │   ├── package.json
        │   ├── fonts/              ← 字体（每项目独立一份，~400 KB）
        │   └── assets/
        │       ├── scene-1.mp3     ← TTS 合成音频
        │       └── scene-N.mp3
        └── logs/                   ← 各阶段 JSON-line 日志
            ├── brief.log
            ├── storyboard.log
            ├── composition.log
            ├── audio.log
            └── render.log
```

渲染出的 `mp4` 不放在这里——Next.js 需要静态服务，视频留在
`web/public/videos/project-{projectId}.mp4`。

## 配置

`web/.env.local` 里的 `WORKBENCH_DATA_DIR` 决定数据目录位置。
留空则回退到 `web/data/projects`（向后兼容）。

```bash
# 当前配置
WORKBENCH_DATA_DIR=/Users/dizhang/self-project/content-analyzer/workbench-data/projects
```

## 单个项目大小

- 元数据 JSON：约 5–10 KB
- composition 目录：约 400 KB（主要是字体）
- logs：约 10–50 KB
- 每个 scene 的 mp3：约 20–80 KB（Azure 中文语音）
- 渲染出的 mp4（存在 `web/public/videos/`）：5–30 MB，取决于时长

**预估：** 一个包含 10 个场景、完整走完流程的项目 ≈ 1 MB
（不含 mp4）。100 个项目 ≈ 100 MB。

## 备份

整个 `workbench-data/` 目录就是"真相源"。直接 `tar -czf` 即可：

```bash
tar -czf workbench-backup-$(date +%F).tgz \
  /Users/dizhang/self-project/content-analyzer/workbench-data/
```

## 清理

删某个项目：

```bash
# 删数据
rm -rf workbench-data/projects/proj_XXX/
rm workbench-data/projects/proj_XXX.json

# 删渲染出的视频
rm web/public/videos/project-proj_XXX.mp4
```

也可以直接在 UI 里点"删除项目"——代码会把三处都清干净。
