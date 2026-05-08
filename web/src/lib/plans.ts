import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data", "plans");

export interface ContentPlan {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceAnalyses: string[]; // history entry IDs

  // Stage 1: Script (文案)
  angle: string;           // 切入点/核心观点
  outline: SceneOutline[]; // 场景大纲
  script: string;          // 完整文案（自由编辑）

  // Stage 2: HTML (Design)
  htmlStyle?: string;      // 风格选择（如 'minimal', 'editorial', 'data-dense'）
  htmlContent?: string;    // 生成的 HTML
  htmlUpdatedAt?: string;  // HTML 上次生成时间

  // Stage 3: Video (Render)
  videoEngine?: "hyperframes" | "remotion"; // 渲染引擎
  videoUrl?: string;       // 视频文件 URL
  videoRenderedAt?: string;

  // Meta
  topics: string[];
  notes: string;

  // Current stage indicator
  currentStage: "script" | "html" | "video";
}

export interface SceneOutline {
  id: string;
  title: string;        // 场景标题
  type: "hook" | "content" | "data" | "action" | "closing";
  duration: number;     // 秒
  content: string;      // 场景内容要点（多行）
  notes?: string;       // 创作备注
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function createPlan(plan: Omit<ContentPlan, "id" | "createdAt" | "updatedAt">): Promise<ContentPlan> {
  await ensureDir();
  const id = `p_${Date.now()}`;
  const now = new Date().toISOString();
  const entry: ContentPlan = { id, createdAt: now, updatedAt: now, ...plan };
  await fs.writeFile(path.join(DATA_DIR, `${id}.json`), JSON.stringify(entry, null, 2), "utf-8");
  return entry;
}

export async function getPlan(id: string): Promise<ContentPlan | null> {
  await ensureDir();
  try {
    const content = await fs.readFile(path.join(DATA_DIR, `${id}.json`), "utf-8");
    return JSON.parse(content) as ContentPlan;
  } catch {
    return null;
  }
}

export async function updatePlan(id: string, updates: Partial<Omit<ContentPlan, "id" | "createdAt">>): Promise<ContentPlan | null> {
  const existing = await getPlan(id);
  if (!existing) return null;
  const updated: ContentPlan = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(DATA_DIR, `${id}.json`), JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}

export async function deletePlan(id: string): Promise<boolean> {
  await ensureDir();
  try {
    await fs.unlink(path.join(DATA_DIR, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function listPlans(): Promise<ContentPlan[]> {
  await ensureDir();
  let files: string[];
  try {
    files = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }
  const plans: ContentPlan[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const content = await fs.readFile(path.join(DATA_DIR, file), "utf-8");
      plans.push(JSON.parse(content) as ContentPlan);
    } catch {
      continue;
    }
  }
  plans.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return plans;
}
