# Requirements Document

## Introduction

Video Creation Workbench 是把现有的 `content-analyzer/web`（Next.js 16 + React 19 + Tailwind 4 + shadcn/ui）改造成一个本地可视化视频创作工作台。每个视频是一个 Project，从 brief（内容卡）一路走到 render（mp4 产出），由一条状态机驱动。创意和结构生成（brief→storyboard→HTML、以及 scene 改写）由本地 `kiro-cli chat` 子进程（默认 Claude Sonnet 4.6）完成；确定性环节（目录初始化、schema 校验、Azure Speech TTS、音频注入、HyperFrames 渲染、预览、状态流转）由本地代码完成。HyperFrames 项目模板通过 `HYPERFRAMES_TEMPLATE_DIR` 环境变量指定（默认指向 `workbench-data/_template/hf-blank`），每个 Project 在 `data/projects/{projectId}/composition/` 下拥有自己的一份完整模板实例，通过 `npx hyperframes render` 产出 mp4 到 `public/videos/`。

MVP 范围：输入一个 topic，输出一个可预览、可修改、可渲染的 mp4 项目。UI 只做两页（`/projects` 列表页、`/projects/[id]` 详情页），详情页含 6 个 Tab（Brief / Storyboard / HTML / Audio / Render / QA）和 scene 抽屉。本次不涉及登录、多用户、云端部署，存储全部在本地文件系统。

## Glossary

- **Workbench**: 本 feature 整体，运行在 `content-analyzer/web` 下的本地创作工作台。
- **Project**: 一个视频项目，对应磁盘上的 `data/projects/{projectId}.json`（元数据）+ `data/projects/{projectId}/` 目录（composition 与 artifacts）。
- **ProjectId**: Project 唯一 ID，格式 `proj_{timestamp}_{6位随机}`，kebab-case 兼容、文件系统安全。
- **Stage**: Project 所处的阶段，枚举值：`topic` | `brief` | `storyboard` | `composition` | `audio` | `render` | `qa` | `published`。
- **StatusMachine**: Project 的状态机，规定 Stage 之间的允许转移。
- **Topic**: 第一阶段的输入，一段中文或英文自由文本，描述"要做什么视频"。
- **Brief**: 内容卡，AI 根据 Topic 生成的结构化简介（标题、目标观众、核心观点、语气、时长预算等）。
- **Storyboard**: 分镜，由一组有序的 Scene 组成。
- **Scene**: 分镜中的一个镜头，含 id、index、文案（narration）、时长、voice、audioPath、qaNote 等字段。
- **Composition**: HyperFrames HTML 场景，落盘到 `data/projects/{projectId}/composition/` 下，结构对齐 `hf-blank` 模板。
- **Audio**: 每个 Scene 的 TTS 音频文件（mp3），由 Azure Cognitive Services Speech REST API 生成，存放在 `composition/assets/scene-{index}.mp3`。
- **Render**: 调用 `npx hyperframes render` 将 composition 渲染成 mp4，产物落到 `public/videos/project-{projectId}.mp4`。
- **QA**: 用户对渲染产物打的 note，可以指向整个视频，也可以指向某个 Scene；指向 Scene 时可触发该 Scene 的 AI 重写。
- **Template**: 指 HyperFrames 模板目录（`hyperframes.json` / `index.html` / `meta.json` / `package.json` / `fonts/`），路径由 `HYPERFRAMES_TEMPLATE_DIR` 环境变量指定，作为 Composition 的模板来源。
- **AIGenerator**: 负责调用本地 Kiro CLI（Claude 模型）的服务端模块，封装 topic→brief、brief→storyboard、storyboard→HTML、qa→scene 改写四种任务。通过 `kiro-cli chat --no-interactive` 子进程完成所有 LLM 调用，不使用 HTTP API，不需要 API key；默认模型 `claude-sonnet-4.6`，可通过 `KIRO_MODEL` 环境变量切换；二进制路径可通过 `KIRO_CLI_BIN` 环境变量覆盖。
- **TTSService**: 封装 Azure Cognitive Services Speech REST API 的服务端模块，通过 `AZURE_SPEECH_ENDPOINT` / `AZURE_SPEECH_KEY` 环境变量认证。
- **RenderService**: 封装 HyperFrames CLI（lint / validate / render）的服务端模块。
- **ProjectStore**: 本地文件系统存储层，负责 Project 元数据的读写与目录初始化。
- **ArtifactPath**: Project 产物路径集合（briefPath、storyboardPath、compositionDir、audioPaths、videoPath 等）。
- **ScenePrompt**: AI 生成 Scene 或改写 Scene 时使用的 prompt 契约，定义输入 schema 与输出 schema。

## Requirements

### Requirement 1: Project 状态机

**User Story:** 作为创作者，我想让每个视频项目按固定阶段推进，这样我能清楚知道当前在哪一步、下一步是什么，也能放心地回退重做某一步。

#### Acceptance Criteria

1. THE Workbench SHALL 定义 Project 的 Stage 枚举值为 `topic`、`brief`、`storyboard`、`composition`、`audio`、`render`、`qa`、`published` 共 8 个值。
2. WHEN 一个新 Project 被创建，THE Workbench SHALL 将该 Project 的 stage 初始化为 `topic`，并将 `stageStatus` 中每个 Stage 的 status 初始化为 `pending`。
3. THE StatusMachine SHALL 只允许以下前进转移：`topic → brief`、`brief → storyboard`、`storyboard → composition`、`composition → audio`、`audio → render`、`render → qa`、`qa → published`。
4. THE StatusMachine SHALL 允许从 `qa` 回退到 `storyboard`、`composition` 或 `audio`（用于接收 QA note 后重做对应阶段），回退时将目标 Stage 及其后续所有 Stage 的 `stageStatus` 重置为 `pending`。
5. IF 客户端请求的 stage 转移不在允许的转移集合内（包含从 `published` 发起的任何转移），THEN THE Workbench SHALL 拒绝请求并返回 HTTP 409，错误体包含 `currentStage`、`requestedStage`、`allowedNextStages` 三个字段。
6. WHEN 一个 Stage 转移成功，THE Workbench SHALL 在 Project 的 `stageHistory` 数组末尾追加一条记录，字段含 `fromStage`、`toStage`、`at`（ISO 8601 UTC）、`reason`（可选字符串，≤500 字符）。
7. THE Workbench SHALL 支持每个 Stage 独立的 `status` 值，枚举为 `pending` | `running` | `succeeded` | `failed`，用于记录该 Stage 最近一次任务的执行状态。
8. WHEN 一个 Stage 的任务开始执行，THE Workbench SHALL 将该 Stage 的 status 设为 `running` 并记录 `startedAt`（ISO 8601 UTC 时间戳）。
9. WHEN 一个 Stage 的任务成功完成，THE Workbench SHALL 将该 Stage 的 status 设为 `succeeded` 并记录 `finishedAt`（ISO 8601 UTC 时间戳）。
10. IF 一个 Stage 的任务抛出异常、返回错误结果或执行超过 3600 秒，THEN THE Workbench SHALL 将该 Stage 的 status 设为 `failed`，记录 `error.message`（≤1000 字符）、`error.code`、`finishedAt`（ISO 8601 UTC 时间戳），且保持 Project 当前 stage 不变（不自动前进）。
11. IF 同一 Project 同时收到多个 stage 转移请求，THEN THE Workbench SHALL 只允许一个请求成功完成，其余并发请求返回 HTTP 409。

### Requirement 2: Project 数据模型与持久化

**User Story:** 作为创作者，我想让每个项目的元数据、产物路径和历史都存在一个可读的 JSON 文件里，这样即使 UI 崩了我也能直接看文件恢复。

#### Acceptance Criteria

1. THE Workbench SHALL 将每个 Project 的元数据持久化为 `data/projects/{projectId}.json`，使用 UTF-8 编码和 2 空格缩进的 JSON 格式。
2. THE Workbench SHALL 保证 Project JSON 至少包含以下字段及类型约束：`projectId`（string）、`title`（string，1–200 字符）、`stage`（Stage 枚举值）、`stageHistory`（数组，默认 `[]`）、`stageStatus`（对象，每个 Stage 的 status 映射）、`createdAt`（ISO 8601 UTC 字符串）、`updatedAt`（ISO 8601 UTC 字符串）、`topic`（string）、`brief`（对象或 null）、`storyboard`（对象或 null）、`artifacts`（对象）、`qaNotes`（数组，默认 `[]`）。
3. WHEN 一个 Project 被创建，THE Workbench SHALL 生成符合 `^proj_[0-9]+_[a-z0-9]{6}$` 正则的 `projectId`；若生成的 ID 与现有文件冲突，则最多重试 5 次直到获得唯一 ID。
4. WHEN 一个 Project 被创建，THE Workbench SHALL 设置 `createdAt` 与 `updatedAt` 为当前 ISO 8601 UTC 时间戳。
5. WHEN 一个 Project 除 `updatedAt` 自身外的任意字段被更新，THE Workbench SHALL 将 `updatedAt` 刷新为当前 ISO 8601 UTC 时间戳。
6. THE Workbench SHALL 在 Project JSON 中用 `artifacts` 对象记录所有产物的相对路径：`briefPath`、`storyboardPath`、`compositionDir`、`indexHtmlPath`、`hyperframesJsonPath`、`audioPaths`（按 scene index 有序的 mp3 路径数组，尚未生成时为空数组 `[]`）、`videoPath`；尚未生成的单值路径字段默认值为 `null`。
7. WHEN Project JSON 需要写入磁盘，THE Workbench SHALL 确保目标目录存在，然后先写临时文件 `data/projects/{projectId}.json.tmp` 再 `rename` 覆盖，以避免并发写导致的文件损坏。
8. IF 写 Project JSON 过程中发生 I/O 错误（包括写临时文件失败或 rename 失败），THEN THE Workbench SHALL 清理残留的 `.tmp` 文件并返回错误，错误信息包含文件路径与底层错误原因。
9. IF 读取 Project JSON 时解析失败或关键字段（`projectId`、`stage`、`schemaVersion`）缺失，THEN THE Workbench SHALL 返回错误而非静默返回空对象，错误信息包含文件路径与具体原因。
10. IF 读取 Project JSON 时目标文件不存在，THEN THE Workbench SHALL 返回一个明确的 "not found" 错误，不返回空对象也不创建新文件。
11. THE Workbench SHALL 在 Project JSON 中记录 `schemaVersion` 字段，当前值固定为 `1`。
12. IF 加载一个 Project 的 JSON 且 `schemaVersion` 与当前支持的版本不一致，THEN THE Workbench SHALL 返回错误并在响应中提示需要迁移，不尝试自动修改文件。

### Requirement 3: Scene 数据模型

**User Story:** 作为创作者，我想在分镜里直接控制每个 scene 的文案、时长、配音和 QA 备注，这样我可以针对单个 scene 精确改写和重新生成 TTS，而不必重跑整个视频。

#### Acceptance Criteria

1. THE Workbench SHALL 用一个 `Scene` 对象表示分镜中的一个镜头，至少包含字段：`sceneId`、`index`、`title`（1–40 字符）、`narration`（1–280 字符）、`durationSec`（数字）、`voice`、`audioPath`（字符串或 null）、`qaNote`（字符串，最长 2000 字符）、`updatedAt`（ISO 8601 UTC 字符串）。
2. THE Workbench SHALL 生成符合 `^sc_[a-z0-9]{8}$` 正则的 `sceneId`。
3. THE Workbench SHALL 保证同一个 Project 内 Scene 的 `index` 从 1 开始连续递增且无重复。
4. IF 创建或更新 Scene 时 `durationSec` 不是正数或不在 `[1, 60]` 范围内，THEN THE Workbench SHALL 拒绝写入并返回 HTTP 400。
5. IF 创建或更新 Scene 时 `title` 或 `narration` 超出长度限制或为空字符串，THEN THE Workbench SHALL 拒绝写入并返回 HTTP 400。
6. IF 创建或更新 Scene 时 `voice` 为空字符串或包含控制字符，THEN THE Workbench SHALL 拒绝写入并返回 HTTP 400；未提供 `voice` 时使用默认值 `zh-CN-Xiaochen:DragonHDFlashLatestNeural`。`voice` 字段类型为自由字符串（Azure Cognitive Services 语音名称，例如 `zh-CN-Xiaochen:DragonHDFlashLatestNeural`、`zh-CN-XiaoxiaoNeural`），UI 仅展示 `constants.VOICES` 中的白名单；TTS 阶段若传入的 `voice` 不在白名单内则回退到默认值并写一条日志，不阻断写入。
7. IF 创建或更新 Scene 时 `qaNote` 超过 2000 字符，THEN THE Workbench SHALL 拒绝写入并返回 HTTP 400。
8. WHEN 一个 Scene 的 `narration` 或 `voice` 被更新，THE Workbench SHALL 将该 Scene 的 `audioPath` 设为 `null`，以强制下一次 audio 阶段重新生成 TTS。
9. WHEN Storyboard 中的 Scene 顺序被调整、新增或删除，THE Workbench SHALL 自动重算每个 Scene 的 `index` 使其从 1 开始连续递增，并同步更新 `composition/assets/scene-{index}.mp3` 的命名映射记录。

### Requirement 4: AI 生成契约 — topic → brief

**User Story:** 作为创作者，我想输入一个宽泛的 topic 让 AI 帮我写一张结构化的 brief，这样我能用 10 秒看清这期视频要讲什么、给谁看、用什么语气。

#### Acceptance Criteria

1. WHEN 客户端向 `POST /api/projects/{projectId}/brief/generate` 提交且 Project stage 为 `topic` 且 Project 的 `topic` 字符串长度在 `[1, 500]` 范围内，THE AIGenerator SHALL 基于 Project 的 `topic` 字段调用 LLM 生成 Brief，单次 LLM 请求超时上限 60 秒。
2. THE AIGenerator SHALL 要求 topic→brief 任务的 LLM 返回一个 JSON 对象，字段包括：`title`（1–60 字符）、`audience`（1–200 字符）、`corePoints`（3–5 条 string 数组，每条 1–200 字符）、`tone`（1–60 字符）、`targetDurationSec`（整数，范围 `[20, 180]`）、`suggestedStyle`（1–200 字符）；"合法 Brief" 定义为所有字段存在且满足上述约束。
3. IF LLM 返回不能被解析为合法 Brief JSON，THEN THE AIGenerator SHALL 最多重试 2 次（共 3 次尝试），每次重试使用更严格的 JSON schema 提示，每次尝试独立应用 60 秒超时。
4. IF 3 次尝试后仍无法得到合法 Brief，THEN THE AIGenerator SHALL 将该阶段 status 置为 `failed`、保持 Project stage 为 `topic`、不写 `brief.json`，并返回 HTTP 502，错误体包含最后一次 LLM 原文片段（截断至 500 字符，以 `…` 结尾表示截断）。
5. WHEN Brief 生成成功，THE Workbench SHALL 将 Brief JSON 写入 `data/projects/{projectId}/brief.json`、更新 Project 的 `brief` 字段与 `artifacts.briefPath`，并把 stage 从 `topic` 推进到 `brief`；若上述任一写入步骤失败，整体回滚（不留部分更新）。
6. IF 客户端在 stage 为 `brief` 或之后的 Project 上调用 brief 生成接口而请求体未携带 `force: true`，THEN THE Workbench SHALL 返回 HTTP 409。
7. THE AIGenerator SHALL 要求 LLM 返回的所有自然语言字段（`title`、`audience`、`corePoints` 每一条、`tone`、`suggestedStyle`）的书写语言与 Project 的 `locale` 字段一致，`locale` 默认值为 `zh-CN`。
8. WHEN 客户端在已有 Brief 的 Project 上以 `force: true` 调用生成接口，THE Workbench SHALL 覆盖原 `brief.json` 并将对应 Stage 的 status 重置为 `running` 后按 Criterion 1–5 的主流程执行。
9. IF 请求中 `projectId` 对应的 Project 不存在，或 Project 的 `topic` 为空字符串或长度超过 500 字符，THEN THE Workbench SHALL 返回 HTTP 422，错误体指明具体原因。

### Requirement 5: AI 生成契约 — brief → storyboard

**User Story:** 作为创作者，我想让 AI 根据 brief 拆出一组 scene，每个 scene 有明确文案和时长，这样我可以直接在分镜里微调，而不必从空白开始写。

#### Acceptance Criteria

1. WHEN 客户端向 `POST /api/projects/{projectId}/storyboard/generate` 提交且 Project stage 为 `brief` 且 Project 的 `brief` 字段非空，THE AIGenerator SHALL 基于 Project 的 Brief 生成 Storyboard，单次 LLM 请求超时上限 60 秒。
2. IF 客户端调用 `POST /api/projects/{projectId}/storyboard/generate` 时 Project stage 非 `brief` 或 Project 的 `brief` 字段为空，THEN THE Workbench SHALL 拒绝请求并返回 HTTP 409。
3. THE AIGenerator SHALL 要求 brief→storyboard 任务返回 `scenes` 数组，长度在 `[3, 20]` 之间，每个 scene 字段包括：`title`（1–40 字符）、`narration`（1–280 字符）、`durationSec`（整数，`[2, 30]`）、`voice`（Azure 语音名称字符串，约束按 Requirement 3 第 6 条）。
4. THE AIGenerator SHALL 保证生成的 Storyboard 中所有 scene 的 `durationSec` 之和落在 Brief 的 `targetDurationSec` ± 15% 范围内。
5. IF 生成的 scenes 总时长超出上一条允许的容差，THEN THE AIGenerator SHALL 最多重试 1 次；二次仍失败则以生成结果为准，并在 response 中返回 `warning` 字段，包含 `actualTotalSec`、`targetDurationSec`、`toleranceRange`（容差区间）、`deviationPercent`（偏差百分比）。
6. IF AI 调用超时或返回结构不符合 Criterion 3 的 schema（如 scene 数量超出 `[3, 20]`、字段缺失或类型错误），THEN THE Workbench SHALL 将 storyboard 阶段 status 置为 `failed`、保持 Project stage 为 `brief`、不写 `storyboard.json`，并返回 HTTP 502。
7. WHEN Storyboard 生成成功，THE Workbench SHALL 按 LLM 返回的 scenes 顺序为每个 scene 分配 `sceneId` 与从 1 开始连续递增的 `index`，写入 `data/projects/{projectId}/storyboard.json`，更新 Project 的 `storyboard` 字段与 `artifacts.storyboardPath`，并把 stage 从 `brief` 推进到 `storyboard`。
8. THE Workbench SHALL 允许客户端在 storyboard 阶段通过 `PATCH /api/projects/{projectId}/scenes/{sceneId}` 修改单个 Scene 的 `title`、`narration`、`durationSec`、`voice` 字段，字段约束按 Requirement 3 执行。
9. THE Workbench SHALL 允许客户端通过 `POST /api/projects/{projectId}/scenes` 新增 Scene、`DELETE /api/projects/{projectId}/scenes/{sceneId}` 删除 Scene，并在变更后自动重算 `index`（从 1 开始连续递增）。
10. IF `PATCH` / `POST` / `DELETE` scene 的操作会导致 Storyboard 的 scene 数量超出 `[3, 20]` 范围或 Project stage 不在 `{storyboard, composition, audio, render, qa}` 集合内，THEN THE Workbench SHALL 拒绝操作并返回 HTTP 409。

### Requirement 6: AI 生成契约 — storyboard → HTML composition

**User Story:** 作为创作者，我想让 AI 根据分镜生成 HyperFrames 格式的 HTML 场景，这样我可以直接走本地渲染，不必手写 HTML 模板。

#### Acceptance Criteria

1. WHEN 客户端向 `POST /api/projects/{projectId}/composition/generate` 提交且 Project stage 为 `storyboard`，THE AIGenerator SHALL 基于 Storyboard 调用 LLM 生成 HyperFrames HTML，单次 LLM 请求超时上限 90 秒。
2. IF 客户端调用该接口时 Project stage 非 `storyboard` 或 Storyboard 为空，THEN THE Workbench SHALL 拒绝请求并返回 HTTP 409。
3. THE AIGenerator SHALL 在 prompt 中显式要求：每个 timed element 必须同时具备 `data-start`、`data-duration`、`data-track-index`；可见的 timed element 必须带 `class="clip"`；GSAP timeline 必须 `paused` 并注册到 `window.__timelines`；不允许 `Date.now()`、`Math.random()`、网络 fetch。
4. THE AIGenerator SHALL 要求输出的 HTML 根 timeline 总时长等于 Storyboard 所有 scene `durationSec` 之和（容差 ±0.5 秒）。
5. WHEN HTML 生成成功，THE Workbench SHALL 将结果写入 `data/projects/{projectId}/composition/index.html` 并调用 `npx hyperframes lint` 与 `npx hyperframes validate` 做二次校验，每条 CLI 命令超时 30 秒。
6. IF `hyperframes lint` 或 `hyperframes validate` 报错，THEN THE Workbench SHALL 将错误文本回传给 AIGenerator 做一次自动修复重试（最多 1 次）。
7. IF 自动修复后仍校验失败，THEN THE Workbench SHALL 将 composition 阶段 status 置为 `failed`，保留失败的 `index.html` 作为 `composition/index.failed.html` 以便人工排查，并返回 HTTP 502 与完整 stderr（截断至 4000 字符）。
8. WHEN composition 生成且校验成功，THE Workbench SHALL 将 stage 从 `storyboard` 推进到 `composition` 并更新 `artifacts.indexHtmlPath`。

### Requirement 7: AI 生成契约 — QA → scene 重写

**User Story:** 作为创作者，我想对某个 scene 写一句"这里太啰嗦"就让 AI 只重写这一个 scene，这样我不用重跑整个 storyboard 和 HTML。

#### Acceptance Criteria

1. WHEN 客户端向 `POST /api/projects/{projectId}/scenes/{sceneId}/rewrite` 提交且 body 中 `qaNote` 长度在 `[1, 500]` 之间，THE AIGenerator SHALL 仅针对该 Scene 调用 LLM 生成新的 `narration`（长度 `[10, 2000]` 字符）与可选的新 `durationSec`（`[3, 300]` 秒）。
2. THE AIGenerator SHALL 在 prompt 中提供该 Scene 的当前 `narration`、`durationSec`、`qaNote`，以及前后相邻 Scene 的 `narration` 作为上下文；如目标是第一个 Scene，则"前一 Scene narration" 以空字符串占位；如目标是最后一个 Scene，则"后一 Scene narration" 以空字符串占位。
3. THE AIGenerator SHALL 保证改写后的 Scene `durationSec` 与改写前的差值在 ±30% 范围内，除非 `qaNote` 明文包含以下关键词之一：`改时长`、`change duration`、`缩短`、`加长`、`shorten`、`lengthen`。
4. WHEN Scene 改写成功，THE Workbench SHALL 以原子事务更新 Scene 的 `narration`、`durationSec`、`qaNote`、`updatedAt`（服务器 UTC 时间），清空其 `audioPath`（触发 TTS 重生成），并将 Project stage 回退到 `storyboard`（保留 composition 已生成的 HTML，但需要在 composition 阶段重新生成该 scene 对应片段）；任一子步骤失败则整体回滚。
5. IF Scene 改写后导致 Storyboard 总时长变化超过 ±10%，THEN THE Workbench SHALL 在响应中标记 `compositionRegenRequired: true`，UI 据此提示用户重新生成 HTML；否则标记 `compositionRegenRequired: false`。
6. IF 请求中 `projectId` 不存在、`sceneId` 不属于该 Project、Project stage 不在 `{storyboard, composition, audio, render, qa}` 集合内，或 `qaNote` 为空、超长或缺失，THEN THE Workbench SHALL 返回 HTTP 404（资源不存在）或 HTTP 400（参数非法），并不修改任何 Project 数据。
7. IF LLM 调用超时（超过 60 秒）或返回不符合 Criterion 1 字段约束的结果，THEN THE Workbench SHALL 保持 Scene 原值、不清空 `audioPath`、不回退 stage，并返回 HTTP 502。

### Requirement 8: 本地文件系统布局与项目目录初始化

**User Story:** 作为创作者，我希望每个项目都是磁盘上一个完整自洽的文件夹，这样我能把它整个 zip 走、也能直接丢给 HyperFrames CLI 跑。

#### Acceptance Criteria

1. WHEN 一个 Project 被创建，THE ProjectStore SHALL 在 `data/projects/{projectId}/` 下初始化以下子结构：`composition/index.html`、`composition/hyperframes.json`、`composition/meta.json`、`composition/package.json`、`composition/assets/.gitkeep`、`composition/fonts/.gitkeep`。
2. WHEN 一个 Project 被创建，THE ProjectStore SHALL 从 HyperFrames 模板拷贝（而不是软链接）`hyperframes.json`、`package.json`、`fonts/` 到新 Project 的 `composition/` 下。
3. WHEN 一个 Project 被创建，THE ProjectStore SHALL 将 `composition/meta.json` 写为 `{ "id": "{projectId}", "name": "{title}", "createdAt": "{ISO-UTC}" }`，覆盖模板原值。
4. WHEN 一个 Project 被创建，THE ProjectStore SHALL 将 `composition/index.html` 初始化为最小占位 HTML，内容至少包含 `<div class="clip" data-start="0" data-duration="1" data-track-index="0">placeholder</div>`；该占位文件在 composition 阶段 AI 生成成功时被整体覆盖。
5. IF HyperFrames 模板目录在 `HYPERFRAMES_TEMPLATE_DIR` 指定的路径以及 `../hf-blank`、`../../hf-blank` 都不存在或不可读，THEN THE ProjectStore SHALL 拒绝创建 Project 并返回 HTTP 500，错误信息明示已尝试的所有模板路径。
6. WHEN 一个 Project 被删除，THE ProjectStore SHALL 删除 `data/projects/{projectId}.json`、`data/projects/{projectId}/` 整个目录，以及 `public/videos/project-{projectId}.mp4`（如存在）。
7. WHEN 读取或写入任何 Project 相关文件前，THE ProjectStore SHALL 校验 `projectId` 符合正则 `^proj_[0-9]+_[a-z0-9]{6}$`，以避免路径注入。
8. IF 传入的 `projectId` 不符合 Criterion 7 的正则，THEN THE ProjectStore SHALL 立即拒绝该请求并返回 HTTP 400，不触碰任何文件系统路径。
9. IF Project 创建流程中任一文件拷贝、写入或目录创建失败，THEN THE ProjectStore SHALL 回滚所有已创建的文件与目录（删除 `data/projects/{projectId}.json` 与 `data/projects/{projectId}/`），返回 HTTP 500 并在错误信息中标明失败的具体步骤。
10. IF Project 删除过程中某个文件或目录删除失败，THEN THE ProjectStore SHALL 继续尝试删除其余路径，最终响应中列出所有删除失败的路径与原因，响应状态码为 HTTP 500。
11. THE Workbench SHALL 将 `data/projects/**` 与 `public/videos/project-*.mp4` 加入 `content-analyzer/web/.gitignore`（若未加入）。

### Requirement 9: TTS 集成（Azure Cognitive Services Speech）

**User Story:** 作为创作者，我希望 audio 阶段用 Azure Speech TTS 把每个 scene 的文案转成 mp3，这样渲染出来的视频能有配音而不是静音。

#### Acceptance Criteria

1. WHEN 客户端向 `POST /api/projects/{projectId}/audio/generate` 提交且 Project stage 为 `composition`，THE TTSService SHALL 遍历 Storyboard 中所有 Scene 并为每个 Scene 调用 Azure Cognitive Services Speech REST API（`POST {AZURE_SPEECH_ENDPOINT}/cognitiveservices/v1`，Body 为 SSML），Storyboard Scene 数量上限 200。
2. IF 请求到达时 Project stage 非 `composition`，THEN THE Workbench SHALL 拒绝请求并返回 HTTP 409。
3. WHEN 处理每个 Scene 时，THE TTSService SHALL 在满足"该 Scene 的 `audioPath` 非空 且对应磁盘 mp3 文件存在 且请求体未携带 `force: true`"时跳过该 Scene；否则为其发起 TTS 请求。
4. WHEN 生成音频成功，THE TTSService SHALL 将 mp3 以原子方式（先写临时文件再 rename）写入 `data/projects/{projectId}/composition/assets/scene-{index}.mp3`，并将对应 Scene 的 `audioPath` 更新为 `assets/scene-{index}.mp3`（相对 composition 目录）。
5. WHEN 为 Scene 发起 TTS 请求时，THE TTSService SHALL 使用该 Scene 的 `voice` 字段作为 SSML `<voice name="...">` 的值（Azure Cognitive Services 语音名称，例如 `zh-CN-Xiaochen:DragonHDFlashLatestNeural`），输出格式固定为 `audio-16khz-128kbitrate-mono-mp3`；若 `voice` 为空或非字符串则回退到默认值 `zh-CN-Xiaochen:DragonHDFlashLatestNeural` 并在日志中记录 fallback 事件。
6. WHEN 单次 Azure Speech 调用执行超过 60 秒或返回非 2xx 响应，THE TTSService SHALL 以指数退避（1 秒、3 秒两次重试，累计最多 3 次请求）重试；3 次累计失败则记录该 Scene 的 `audio.error` 并继续处理其他 Scene；日志不得回显 `AZURE_SPEECH_KEY` 内容。
7. IF 音频写盘失败（磁盘满、权限错误等），THEN THE TTSService SHALL 清理残留的 `.tmp` 文件、标记该 Scene 的 `audio.error` 并继续处理其他 Scene。
8. WHEN 所有 Scene 的 TTS 处理结束，THE TTSService SHALL 汇总结果：若全部 Scene 均已具备有效 mp3 则推进 stage 到 `audio` 并返回 HTTP 200；若至少有一个 Scene 失败则 stage 保持 `composition` 并返回 HTTP 207，响应体中列出失败 Scene 的 `index`、`voice`、`audio.error.code`、`audio.error.message`。
9. IF 环境变量 `AZURE_SPEECH_KEY` 或 `AZURE_SPEECH_ENDPOINT` 缺失或为空字符串，THEN THE TTSService SHALL 在发起任何外部调用前直接返回 HTTP 500 `TTS_PROVIDER_UNCONFIGURED`，错误信息提示配置 `.env.local`，且日志不得回显 key 值。
10. WHEN 全部 Scene 的 TTS 成功且 stage 推进到 `audio` 时，THE Workbench SHALL 先将当前 `composition/index.html` 备份为 `composition/index.prev.html`，然后将每个 Scene 的 mp3 路径注入 `index.html`：为每个 scene 的根节点加一个 `<audio data-start=... data-duration=... src="assets/scene-{index}.mp3" ...>`，或更新已存在的 `<audio>` 标签 `src`；仅对 `audio.error` 为空的 Scene 注入 audio 标签。
11. IF 注入 audio 标签后 `hyperframes lint` / `validate` 失败，THEN THE Workbench SHALL 用 `composition/index.prev.html` 恢复 `composition/index.html`、将 stage 回退到 `composition`，并返回 HTTP 500。
12. IF 需要回滚但 `composition/index.prev.html` 不存在或恢复过程失败，THEN THE Workbench SHALL 将 composition 阶段 status 置为 `failed`、stage 保持当前值、返回 HTTP 500，错误信息中提示需要人工介入。

### Requirement 10: HyperFrames render 集成

**User Story:** 作为创作者，我希望点一下 Render 就能把 composition 跑成 mp4 放到 `public/videos/`，并且能看到渲染进度，这样我不用切终端看日志。

#### Acceptance Criteria

1. WHEN 客户端向 `POST /api/projects/{projectId}/render` 提交且 Project stage 为 `audio`，THE RenderService SHALL 在 `data/projects/{projectId}/composition/` 目录下执行 `npx hyperframes render --output {absPath} --fps 30`，并立即返回 HTTP 202 表示任务已受理。
2. IF `POST /api/projects/{projectId}/render` 请求到达时 Project stage 非 `audio`，THEN THE Workbench SHALL 拒绝请求并返回 HTTP 409。
3. IF 同一 `projectId` 存在一个尚未结束的 render 任务（status 为 `running`），THEN THE Workbench SHALL 拒绝新的 render 请求并返回 HTTP 409。
4. THE RenderService SHALL 将输出路径设置为 `public/videos/project-{projectId}.mp4`；WHEN 该文件已存在，在启动 `npx hyperframes render` 子进程前先将其重命名为 `public/videos/project-{projectId}.prev.mp4`，重命名失败则中止本次 render 并返回 HTTP 500。
5. WHILE render 子进程在运行，THE RenderService SHALL 将其 stdout 与 stderr 以流式追加写入 `data/projects/{projectId}/render.log`，写入延迟不超过 2 秒。
6. WHEN render 子进程运行超过 180 秒仍未退出，THE RenderService SHALL kill 子进程、清理中间临时文件、删除不完整的 `public/videos/project-{projectId}.mp4`、将 render 阶段 status 置为 `failed`，并通过 SSE 推送 `stage: failed` 事件，HTTP 响应码 504。
7. WHILE render 子进程在运行，THE RenderService SHALL 通过 SSE 端点 `GET /api/projects/{projectId}/render/stream` 以至少每 2 秒一次的频率推送进度事件，事件类型含 `stage`（枚举值：`starting` | `rendering` | `encoding` | `done` | `failed`）与 `line`（最近一行日志，截断 500 字符，尚无日志时为空字符串）。
8. WHEN render 子进程以退出码 0 结束且 `public/videos/project-{projectId}.mp4` 存在且文件大小大于 0 字节，THE Workbench SHALL 更新 `artifacts.videoPath` 为 `/videos/project-{projectId}.mp4`，将 render 阶段 status 置为 `succeeded`，stage 推进到 `render`，并通过 SSE 推送 `stage: done` 事件。
9. IF render 子进程以退出码 0 结束但 `public/videos/project-{projectId}.mp4` 不存在或大小为 0 字节，THEN THE Workbench SHALL 视为失败：将 render 阶段 status 置为 `failed`、清理临时文件、通过 SSE 推送 `stage: failed` 事件、HTTP 响应码 500。
10. IF render 子进程以非 0 退出码结束且未超时，THEN THE Workbench SHALL 将 render 阶段 status 置为 `failed`、记录 `error.code` 与 `error.message`（含退出码与 stderr 末尾 500 字符）、删除不完整的输出文件、通过 SSE 推送 `stage: failed` 事件、HTTP 响应码 500。
11. THE RenderService SHALL 保留最近一次 render 成功前的 `public/videos/project-{projectId}.prev.mp4` 至少直到下一次成功 render 完成；新一次成功 render 后可覆盖该 prev 文件。

### Requirement 11: 项目列表页 `/projects`

**User Story:** 作为创作者，我打开工作台时希望第一眼看到所有项目和它们的状态，并能一键新建。

#### Acceptance Criteria

1. WHEN 用户访问 `/projects`，THE Workbench SHALL 渲染一个按 `updatedAt` 倒序排列的 Project 列表，每行显示 `title`（超出 60 字符时末尾以省略号截断）、当前 `stage`、`updatedAt`（相对时间格式：<60 秒显示"刚刚"、<60 分钟显示"N 分钟前"、<24 小时显示"N 小时前"、<30 天显示"N 天前"、≥30 天显示 `YYYY-MM-DD`）、缩略图（若存在 `public/videos/project-{projectId}.poster.jpg` 则展示，否则显示以 `stage` 为区分的阶段色块，8 个 stage 各对应一种固定颜色）。
2. WHILE `/projects` 列表数据正在加载，THE Workbench SHALL 显示加载占位（skeleton 或 loading 指示器），并在加载完成后列表为空时展示"暂无项目"的空状态提示与"新建项目"按钮。
3. THE Workbench SHALL 在 `/projects` 页顶栏常驻一个"新建项目"按钮与一个到 `/` 分析页的返回链接，两者样式与现有 UI 的顶栏组件保持一致（复用同一 Header 组件）。
4. WHEN 用户点击"新建项目"按钮，THE Workbench SHALL 弹出表单要求输入 `title`（1–80 字符，必填，前后空白自动裁剪）与 `topic`（1–500 字符，必填，前后空白自动裁剪）。
5. IF 用户提交的 `title` 或 `topic` 为空、超长或仅含空白字符，THEN THE Workbench SHALL 阻止提交，在对应字段下方展示指明具体原因（为空 / 超出最大长度 / 仅空白）的校验错误提示，并保留用户已输入内容。
6. WHEN 用户提交有效的新建表单，THE Workbench SHALL 调用 `POST /api/projects` 创建 Project（stage = `topic`），在请求返回前禁用提交按钮以防止重复提交，请求成功后跳转到 `/projects/{id}`。
7. IF `POST /api/projects` 返回非成功响应或请求异常，THEN THE Workbench SHALL 保留表单内容不关闭弹窗，展示指示创建失败原因的错误提示，并恢复提交按钮可用状态以便用户重试。
8. WHEN 用户在列表行点击删除按钮，THE Workbench SHALL 弹出包含目标项目 `title` 的二次确认对话框，仅在用户明确确认后调用 `DELETE /api/projects/{id}`；请求成功后将该行从列表移除，若请求返回非成功响应或异常，则保留该行并展示指示删除失败的错误提示。
9. WHILE `/projects` 的 Project 总数超过 20 条，THE Workbench SHALL 采用客户端分页方式每页渲染至多 20 条，并提供上一页/下一页控件，使任意时刻 DOM 中列表行数量不超过 20。

### Requirement 12: 项目详情页 `/projects/[id]` 与 6 个 Tab

**User Story:** 作为创作者，我希望在一页里就能切换 Brief / Storyboard / HTML / Audio / Render / QA，看当前产物、触发下一步、回读上一次日志。

#### Acceptance Criteria

1. WHEN 用户访问 `/projects/{id}`，THE Workbench SHALL 渲染一个两栏布局：左侧为阶段面板（显示 8 个 Stage 的时序与 status 徽章，徽章取值枚举：`pending` | `running` | `succeeded` | `failed` | `skipped`），右侧为 Tab 容器；首屏渲染在 3 秒内完成。
2. THE Workbench SHALL 在右侧提供恰好 6 个 Tab：`Brief`、`Storyboard`、`HTML`、`Audio`、`Render`、`QA`。
3. WHERE 用户位于 `Brief` Tab，THE Workbench SHALL 展示 Brief JSON 的结构化视图（title / audience / corePoints / tone / targetDurationSec / suggestedStyle），并提供"重新生成 Brief"按钮；点击该按钮时弹出二次确认对话框，提示下游 Storyboard / HTML / Audio 可能失效。
4. WHERE 用户位于 `Storyboard` Tab，THE Workbench SHALL 列出所有 Scene 的摘要（index、title、narration 前 60 字、durationSec、voice），并允许点击打开 scene 抽屉。
5. WHERE 用户位于 `HTML` Tab，THE Workbench SHALL 展示 `composition/index.html` 的源码（只读）与一个"在浏览器预览（HyperFrames preview）"的外链按钮。
6. WHERE 用户位于 `Audio` Tab，THE Workbench SHALL 列出每个 Scene 的 mp3 状态（`未生成` | `生成中` | `已生成` | `失败`），提供批量"生成全部"与单个 scene "重新生成 TTS" 按钮，并允许试听已生成 mp3。
7. WHEN 用户在 Audio Tab 点击"生成全部"，THE Workbench SHALL 仅对状态为 `未生成` 或 `失败` 的 Scene 发起 TTS 请求，跳过 `已生成` 与 `生成中` 的 Scene。
8. WHERE 用户位于 `Render` Tab 且 composition 存在且所有 Scene 的 mp3 状态均为 `已生成`，THE Workbench SHALL 启用"渲染"按钮；否则该按钮禁用并以 tooltip 说明缺失条件。
9. WHERE 用户位于 `Render` Tab，THE Workbench SHALL 展示最近一次渲染日志（尾部 200 行，若无则显示"暂无渲染日志"空状态）、渲染进度条（来自 SSE；SSE 断连时显示"连接已断开，点击重试"提示）、以及渲染成功后的 `<video>` 预览。
10. WHERE 用户位于 `QA` Tab，THE Workbench SHALL 展示整个项目级的 `qaNotes` 列表（含每条 note 的时间、作者默认为 `local`、关联 sceneId 或为 null 的项目级 note），提供添加 note 的输入框，单条 note 长度上限 2000 字符。
11. IF 当前 Project stage 不满足某个 Tab 所需前置条件（Brief Tab 需要 stage ≥ `brief`；Storyboard Tab 需要 stage ≥ `storyboard`；HTML Tab 需要 stage ≥ `composition`；Audio Tab 需要 stage ≥ `composition`；Render Tab 需要 stage ≥ `audio`；QA Tab 需要 stage ≥ `render`），THEN THE Workbench SHALL 在 Tab 内显示一个明确的空状态卡片，说明需要先完成的阶段与对应 CTA。
12. IF 用户访问的 `/projects/{id}` 对应 Project 不存在或读取失败，THEN THE Workbench SHALL 渲染一个"项目不存在或无法读取"的错误页面，并提供返回 `/projects` 的链接。

### Requirement 13: Scene 抽屉

**User Story:** 作为创作者，我想点一个 scene 就打开抽屉，在那里编辑文案、时长、voice，触发这个 scene 的 TTS 或 AI 改写。

#### Acceptance Criteria

1. WHEN 用户在 Storyboard Tab 点击一个 Scene，THE Workbench SHALL 从页面右侧滑出 Scene 抽屉。
2. WHILE Scene 抽屉处于打开状态，THE Workbench SHALL 显示并允许编辑以下字段及其约束：`title`（1–40 字符）、`narration`（1–280 字符）、`durationSec`（整数，`[1, 60]`）、`voice`（Azure 语音名称字符串，UI 以下拉方式展示 `constants.VOICES` 白名单）、`qaNote`（0–2000 字符）。
3. WHILE Scene 抽屉处于打开状态，THE Workbench SHALL 提供三个操作按钮：`保存`、`重新生成 TTS`、`基于 QA note 重写 Scene`。
4. WHEN 用户点击`保存`，THE Workbench SHALL 调用 `PATCH /api/projects/{id}/scenes/{sceneId}`，成功后关闭抽屉并刷新 Storyboard 列表。
5. IF `PATCH /api/projects/{id}/scenes/{sceneId}` 返回非成功响应或字段校验失败，THEN THE Workbench SHALL 保留抽屉打开状态、保留用户输入内容，并在对应字段下方或抽屉顶部展示指明失败原因的错误提示。
6. WHEN 用户点击`重新生成 TTS`，THE Workbench SHALL 调用 `POST /api/projects/{id}/scenes/{sceneId}/tts`，仅重跑该 Scene 的 TTS，并在抽屉内以 toast 显示结果。
7. WHEN 用户点击`基于 QA note 重写 Scene` 且 `qaNote` 非空，THE Workbench SHALL 调用 `POST /api/projects/{id}/scenes/{sceneId}/rewrite`，并在返回后以 diff 视图展示改写前后的 `narration`。
8. WHERE diff 视图显示，THE Workbench SHALL 提供"接受改写"与"放弃改写"两个按钮。
9. WHEN 用户点击"接受改写"，THE Workbench SHALL 将改写后的 `narration` 与 `durationSec` 写入 Scene 并刷新抽屉；WHEN 用户点击"放弃改写"，THE Workbench SHALL 丢弃改写结果并恢复抽屉为改写前状态。
10. WHILE `qaNote` 字段为空字符串或仅含空白字符，THE Workbench SHALL 禁用`基于 QA note 重写 Scene` 按钮，并以 tooltip 提示"请先填写 QA note"。

### Requirement 14: 错误处理与可观测性

**User Story:** 作为创作者，当一个阶段失败时，我希望能立刻看到是哪一步挂了、日志写在哪里、是否能一键重试，而不必去翻终端。

#### Acceptance Criteria

1. THE Workbench SHALL 为所有 API 路由的错误响应返回统一错误 schema：`{ "error": { "code": string, "message": string, "details"?: object } }`，其中 `error.code` 为稳定的 ≤64 字符字符串标识符，`error.message` 为 ≤500 字符的可读说明。
2. THE Workbench SHALL 为每个 Project 维护 `data/projects/{projectId}/logs/{stage}.log`，将所有 AI、TTS、Render 任务的 stdout、stderr 与异常堆栈以追加模式写入对应文件。
3. WHEN 单个 `{stage}.log` 文件大小超过 10 MB，THE Workbench SHALL 将其轮转为带序号的历史文件，并最多保留最近 3 个历史文件，多余的旧文件自动删除。
4. WHEN 一个 Stage 任务失败，THE Workbench SHALL 在对应 Stage Tab 顶部展示失败摘要，摘要包含完整 `error.code` 与 `error.message` 前 200 字符，并附"查看完整日志"链接。
5. WHEN 用户点击"查看完整日志"链接，THE Workbench SHALL 在 UI 浮窗中读取并展示对应 `logs/{stage}.log` 文件的尾部 500 行。
6. WHEN AI 或 TTS 任务的单次请求执行超过 120 秒，THE Workbench SHALL 中止该请求并以 HTTP 504 状态码返回符合统一错误 schema 的响应。
7. WHEN 一个 Stage 任务失败，THE Workbench SHALL 在对应 Project JSON 的 `stageStatus.{stage}` 字段中记录最近一次 `error.code` 与截断至前 500 字符的 `error.message`，供列表页失败徽章读取。
8. IF 某个 Stage 在 `stageHistory` 中最近 3 条记录结果均为失败，THEN THE Workbench SHALL 在对应 Stage Tab 顶部显示"建议回退上一阶段重做"的提示文字，且不自动执行回退操作。
9. THE Workbench SHALL 在所有涉及外部调用（本地 Kiro CLI 子进程 / Azure Speech TTS / HyperFrames CLI）的日志条目中记录该次调用的耗时，单位为整数毫秒。

### Requirement 15: 模板复用（hf-blank）

**User Story:** 作为创作者，我希望所有项目共享同一套 HyperFrames 视觉底子，但每个项目能独立改 HTML 不互相污染。

#### Acceptance Criteria

1. WHEN 服务端启动或首次创建 Project 时，THE Workbench SHALL 使用 `process.env.HYPERFRAMES_TEMPLATE_DIR` 指定的路径定位模板目录；若未设置，则按序检查 `../hf-blank`（相对 `content-analyzer/web`）、`../../hf-blank`；取第一个"目录存在、可读、且含 `hyperframes.json`"的路径作为模板源。
2. IF Criterion 1 列出的所有路径都不满足"目录存在、可读、且含 `hyperframes.json`"，THEN THE Workbench SHALL 拒绝创建 Project 并返回 HTTP 500，错误信息明示已尝试的所有路径与每个路径的失败原因。
3. WHEN 创建 Project 时，THE Workbench SHALL 对模板目录做深拷贝（不使用软链接）到 `data/projects/{projectId}/composition/`，保证不同 Project 修改 HTML/assets 互不影响。
4. WHEN 执行 Criterion 3 的深拷贝时，THE Workbench SHALL 排除模板目录下的 `captures/`、`.thumbnails/` 目录以及任意 `*.mp4` 文件（属于模板作者的产物，不属于模板本身）。
5. IF Project 创建流程中模板拷贝任一文件失败，THEN THE Workbench SHALL 删除已拷贝到 `data/projects/{projectId}/` 的所有内容，返回 HTTP 500 并在错误信息中指明失败的文件。
6. WHEN 客户端调用 `POST /api/projects/{id}/composition/sync-template`，THE Workbench SHALL 将模板目录的 `hyperframes.json`、`package.json`、`fonts/` 合并到目标 Project 的 composition 目录，且不覆盖 `index.html` 与 `assets/`。
7. IF Criterion 6 的合并操作检测到 `hyperframes.json` 中的任意字段（包括但不限于 `paths.blocks`）相对于该 Project 创建时使用的模板基线发生了本地改动，THEN THE Workbench SHALL 中止同步、保持 composition 目录不变、返回 HTTP 409 并列出所有冲突字段路径。
8. WHEN 一个 Project 被创建，THE Workbench SHALL 在 Project JSON 的 `templateSource` 字段中记录 `name` 与 `version`；`version` 按"模板 `package.json` 的 `version` 字段 → 模板目录 Git 提交哈希 → 字符串 `unknown`"的顺序取第一个可获得值。

### Requirement 16: Schema 校验与输入安全

**User Story:** 作为开发者，我希望所有 API 输入都被严格校验和 sanitize，避免路径注入、超大 payload、非法字符干扰文件系统和 HyperFrames CLI。

#### Acceptance Criteria

1. THE Workbench SHALL 对所有 API 入参使用 Zod（或等价运行时 schema）做类型、范围与长度校验：普通字符串字段上限 4000 字符，自由文本字段（如 `narration`、`qaNote`、LLM prompt 透传内容）上限 20000 字符。
2. IF Criterion 1 的校验失败，THEN THE Workbench SHALL 返回 HTTP 400，响应体符合统一错误 schema，且 `error.details` 中列出字段级错误（字段路径 + 失败原因）。
3. IF 任何来自用户或 LLM 的字符串字段包含 ASCII 控制字符（0x00–0x08、0x0B、0x0C、0x0E–0x1F、0x7F）或 NUL 字节，THEN THE Workbench SHALL 拒绝写入该字段并返回 HTTP 400。
4. IF `projectId` 或 `sceneId` 参数不匹配 Requirement 2 第 3 条或 Requirement 3 第 2 条定义的正则，THEN THE Workbench SHALL 返回 HTTP 400 且不访问文件系统。
5. IF 单个 API 请求体超过 1 MB（Brief / Storyboard / HTML 生成类接口放宽至 4 MB），THEN THE Workbench SHALL 返回 HTTP 413。
6. IF 任何路径参数或 LLM 输出的路径字符串包含 `..`、绝对路径前缀 `/` 或 `\`、或 NUL 字节，THEN THE Workbench SHALL 返回 HTTP 400（用户输入）或按 Requirement 6 的失败流程处理（LLM 输出），且不对文件系统产生副作用。
7. WHEN LLM 返回 HTML 内容，THE Workbench SHALL 在写盘前做大小写不敏感扫描，若包含 `<iframe`、`<object`、`<embed` 标签或 `fetch(`、`XMLHttpRequest`、`Date.now(`、`Math.random(` 字符串中的任一项，THEN 按 Requirement 6 第 6–7 条的失败流程处理；允许出现 `<script>` 标签。

### Requirement 17: MVP 完整流程（端到端冒烟）

**User Story:** 作为创作者，我希望用 MVP 走一遍就能从 topic 直接得到 mp4，这样我能验证整个工作台是真的能交付视频，而不是一堆半成品。

#### Acceptance Criteria

1. WHEN 用户在 `/projects` 新建项目并提交合法 topic 后访问 `/projects/{id}`，THE Workbench SHALL 在 UI 上依次提供以下可点击入口：生成 Brief、生成 Storyboard、生成 Composition HTML、生成 Audio、Render、添加 QA note、标记为 Published；每个入口在当前 Project stage 不满足其前置条件时处于禁用态并以 tooltip 提示缺失条件。
2. WHEN 每一步对应的后端任务返回成功响应，THE Workbench SHALL 将 Project `stage` 推进到对应阶段，并在 `/projects` 列表页 3 秒内反映出最新的 `stage` 与 `updatedAt`。
3. WHEN render 成功完成，THE Workbench SHALL 保证最终产物落盘为 `content-analyzer/web/public/videos/project-{projectId}.mp4`，文件大小 > 0 字节且可被 Chromium 内置解码器成功解码为至少 1 帧。
4. WHEN 用户在 QA 阶段添加一条 `sceneId` 非空的 note 并触发 Scene 改写，THE Workbench SHALL 在"改写成功 → 重新生成该 Scene 的 TTS → 可选重渲染"的完整路径走完后，保证详情页 Render Tab 能播放最新 mp4 且所有 Scene 的 mp3 状态均为 `已生成`。
5. WHEN 用户点击"标记为 Published" 且 Project 当前 stage 为 `render` 或 `qa` 且 `artifacts.videoPath` 指向的 mp4 文件存在且大小 > 0，THE Workbench SHALL 将 stage 推进到 `published` 并返回 HTTP 200。
6. IF 点击"标记为 Published" 时 Project 当前 stage 不在 `{render, qa}` 内或 `artifacts.videoPath` 为 null 或目标 mp4 不存在或大小为 0，THEN THE Workbench SHALL 返回 HTTP 409，响应体中指明具体缺失条件。
7. IF MVP 流程中任一生成步骤（brief / storyboard / composition / audio / render）失败，THEN THE Workbench SHALL 保持 Project 的 `stage` 不变、在对应 Stage Tab 顶部展示失败摘要（按 Requirement 14 的错误处理规范），允许用户不重启流程直接重试该步骤。
