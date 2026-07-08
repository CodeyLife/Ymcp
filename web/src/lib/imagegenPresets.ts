/**
 * imagegen 技能的提示词预设与 AI 润色系统 prompt
 * 规则来源：C:\Users\admin\.codex\skills\.system\imagegen 的 SKILL.md / prompting.md
 *
 * 预留扩展位：category 可后续增加 "lighting" | "composition" | "mood" 等类别，
 * 届时在 ImageGen.tsx 按 category 分组渲染即可。
 */

export type PresetCategory = "style" | "lighting" | "composition" | "mood";

export interface PromptPreset {
  id: string;
  label: string;
  category: PresetCategory;
  /** 注入到生图提示词的片段（调用时拼接，非写入用户输入框） */
  fragment: string;
  /** 鼠标悬浮/选中时的说明 */
  description?: string;
}

/**
 * 画风预设。fragment 采用 imagegen shared prompt schema 的 `Style/medium: ...` 行格式，
 * 便于与用户提示词自然衔接。`id === "none"` 时不注入任何内容。
 */
export const STYLE_PRESETS: PromptPreset[] = [
  {
    id: "none",
    label: "无",
    category: "style",
    fragment: "",
    description: "不注入画风，仅使用用户提示词",
  },
  {
    id: "photorealistic",
    label: "写实摄影",
    category: "style",
    fragment:
      "Style/medium: photorealistic photo, real-world texture (pores, wrinkles, fabric wear, material grain), natural lighting, camera-captured look, shallow depth of field, subtle film grain",
    description: "真实摄影质感、自然光影、胶片颗粒",
  },
  {
    id: "casual-snapshot",
    label: "随手拍",
    category: "style",
    fragment:
      '请生成一张类似iPhone随拍的照：没有明确主题，没有刻意构图，只是很普通，甚至有点失败的快照。照略带运动模糊，光线不均，轻微曝光过度，角度尴尬，构图混乱，整体呈现出一种"过于真实的随手一拍感"，就像是从口袋里拿出手机不小心按到的自拍。',
    description: "iPhone 随拍、普通快照、轻微失败感",
  },
  {
    id: "cinematic",
    label: "电影感",
    category: "style",
    fragment:
      "Style/medium: cinematic concept art, volumetric lighting, dramatic mood, anamorphic lens flare, rich contrast, atmospheric haze, film-still composition",
    description: "电影级光影、体积光、戏剧化氛围",
  },
  {
    id: "illustration",
    label: "插画",
    category: "style",
    fragment:
      "Style/medium: digital illustration, clean linework, flat or cel shading, stylized shapes, balanced color blocks",
    description: "数字插画、干净线稿、色块分明",
  },
  {
    id: "comic",
    label: "漫画",
    category: "style",
    fragment:
      "Style/medium: comic book illustration, bold ink outlines, halftone shading, saturated panels, graphic novel aesthetic",
    description: "漫画风、粗线描边、半调网点",
  },
  {
    id: "watercolor",
    label: "水彩",
    category: "style",
    fragment:
      "Style/medium: watercolor painting, soft washes, bleeding pigments, visible paper texture, loose brushwork, transparent layers",
    description: "水彩晕染、纸纹、透明叠色",
  },
  {
    id: "oil-painting",
    label: "油画",
    category: "style",
    fragment:
      "Style/medium: oil painting, visible impasto brushstrokes, rich texture, layered glazes, classical chiaroscuro",
    description: "油画笔触、厚涂、明暗对比",
  },
  {
    id: "pixel-art",
    label: "像素艺术",
    category: "style",
    fragment:
      "Style/medium: pixel art, limited color palette, crisp hard-edged pixels, dithering, low-resolution retro aesthetic",
    description: "像素风、有限调色板、复古",
  },
  {
    id: "3d-render",
    label: "3D 渲染",
    category: "style",
    fragment:
      "Style/medium: 3D render, octane render, soft global illumination, subsurface scattering, photoreal materials, smooth normals",
    description: "3D 渲染、全局光照、次表面散射",
  },
  {
    id: "minimal",
    label: "极简",
    category: "style",
    fragment:
      "Style/medium: minimal flat design, ample negative space, restrained palette, simple geometric forms, clean silhouette",
    description: "极简扁平、留白、克制配色",
  },
  {
    id: "cyberpunk",
    label: "赛博朋克",
    category: "style",
    fragment:
      "Style/medium: cyberpunk aesthetic, neon signage, rain-slick streets, high-tech low-life mood, magenta and cyan glow, futuristic dystopia",
    description: "赛博朋克、霓虹、雨夜都市",
  },
  {
    id: "ghibli",
    label: "吉卜力",
    category: "style",
    fragment:
      "Style/medium: Studio Ghibli style anime, soft watercolor backgrounds, hand-drawn warmth, gentle natural light, nostalgic pastoral mood",
    description: "吉卜力风、手绘水彩背景、怀旧",
  },
  {
    id: "k-style-2.5d",
    label: "半写实动漫",
    category: "style",
    fragment:
      "Style/medium: semi-realistic anime, 2.5D, stylized proportions, soft shading.",
    description: "半写实动漫 + 光泽皮肤 + 柔光 + 精致五官",
  },
];

export interface Img2ImgReferenceGuide {
  id: string;
  label: string;
  fragment: string;
  description?: string;
}

export const IMG2IMG_REFERENCE_GUIDES: Img2ImgReferenceGuide[] = [
  {
    id: "appearance-anchor",
    label: "人物一致性",
    fragment:
      `从参考图中锁定该人物的身份特征：脸型与五官比例、肤色与发色、发型大类、整体气质。这些特征在新画面中保持可识别。

换一组全新照片——以下几项必须全部改变：
1. 头部朝向与视线：改为不同的角度和视线方向（正脸/侧脸/抬头/低头/看镜头/看别处）
2. 身体姿势与手部动作：改为不同的姿态
3. 服装：换一套完全不同的服装
4. 场景与机位：换到不同的环境，用不同的拍摄距离和角度

将参考图视为该角色的"档案照"，你要拍的是同一个人的另一张完全不同的生活照。身份一眼能认出，但画面必须是全新的一张。

下方"新画面描述"可为空、可为关键词、可为完整描述：
- 若为空：自由构思一个合理的新画面（场景+表情+动作+机位全部重新设计）。
- 若为关键词：作为核心方向（如"海边"→海边场景+适配的表情动作），其余由你补全。
新画面描述：`,
    description: "保持角色外观特征（脸型五官、肤色发色、气质），强制改变表情/姿势/服装/场景/机位，生成全新照片而非原图微调",
  },
  {
    id: "same-scene-second-shot",
    label: "同场景二次拍摄",
    fragment:
      `从参考图中锁定该人物的身份特征：脸型与五官比例、肤色与发色、发型大类、整体气质。这些特征在新画面中保持可识别。

保持同一套服装的款式、主色、材质、层次、配饰和穿搭识别度。有自然褶皱、姿态牵动和光影变化，

识别参考图所属的大环境类型，例如学校、商场、公园、街道、咖啡馆、办公室、海边等。新画面必须仍在同一个大环境内，可以换到该环境中的另一处具体取景点。

以下几项必须全部改变：
1. 具体取景点：可在同一大环境内更换位置。
2. 人物状态：重新设计头部朝向、视线方向、表情、身体姿势、动作和手部动作。
3. 拍摄方式：重新设计机位、镜头距离、构图、裁切、画面重心和人物在画面中的位置。
4. 环境互动：可让人物与同一大环境中的新位置自然互动，例如走动、回头、侧身、坐下、倚靠、整理衣物、看向远处或与附近道具互动。

将参考图视为“该人物穿着这套服装、处在这个大环境中的一张样片”。你要拍的是同一人物在同一大环境中的另一张新照片，而不是原图的变体、换脸、局部重绘或简单连拍。

新画面描述：`,
    description: "保留同一人物、同一套服装和同一个大环境（如学校/商场/公园），在该环境内更换具体取景点、姿势、表情、动作和机位，生成新的独立照片",
  },
];

/**
 * AI 润色用的 system prompt，编码 imagegen 技能的提示词约束。
 * 关键点：
 * - 遵循 shared prompt schema（labeled spec，按需取用）
 * - 遵循 specificity policy（具体则归一化，笼统则 tasteful augmentation）
 * - 不得添加未暗示的角色/道具/品牌/口号
 * - 结构顺序：scene/backdrop → subject → details → constraints
 * - 用户已选画风作为上下文给出，AI 不得输出 Style/medium 行（由画风 tab 调用时注入，避免重复）
 * - 仅输出最终 prompt，无解释、无 markdown 围栏
 */
export const IMAGEGEN_SYSTEM_PROMPT = `You are an expert image generation prompt engineer. Rewrite the user's prompt into a structured, production-oriented spec following the imagegen shared prompt schema.

Shared prompt schema (use only the lines that materially help; short labeled lines for complex requests):
- Use case: <taxonomy slug>
- Asset type: <where the asset will be used>
- Primary request: <user's main prompt>
- Scene/backdrop: <environment>
- Subject: <main subject>
- Composition/framing: <wide/close/top-down; placement>
- Lighting/mood: <lighting + mood>
- Color palette: <palette notes>
- Materials/textures: <surface details>
- Text (verbatim): "<exact text>"
- Constraints: <must keep/must avoid>
- Avoid: <negative constraints>

Structure order: scene/backdrop -> subject -> details -> constraints.

Specificity policy:
- If the user's prompt is already specific and detailed, preserve that specificity and only normalize/structure it. Do NOT add creative requirements.
- If the user's prompt is generic, add tasteful augmentation only when it materially improves the result.

Allowed augmentations: composition/framing cues, intended-use or polish-level hints, practical layout guidance, reasonable scene concreteness.
NOT allowed: extra characters/props/objects not implied by the request, brand names/slogans/palettes not implied, arbitrary left/right placement unless the surrounding layout supports it.

The user may provide a selected style fragment as context. Make the rest of the prompt coherent with that style, but DO NOT output a "Style/medium" line — the style is injected separately at generation time. Adding it here would cause duplication.

You MUST write the final polished prompt in Chinese (中文). Keep labeled line prefixes (such as "Use case:", "Scene/backdrop:", "Subject:", "Lighting/mood:", "Constraints:", "Avoid:") in English; fill the values in Chinese.

Output ONLY the final polished prompt. No explanations, no markdown fences, no preamble.`;

/**
 * 拼装 AI 润色的 user message：包含用户当前提示词与（若有）选中的画风片段说明。
 */
export function buildPolishUserMessage(prompt: string, styleFragment?: string): string {
  const trimmed = prompt.trim();
  if (!styleFragment || !styleFragment.trim()) {
    return `Rewrite the following image generation prompt into the structured spec:\n\n${trimmed}`;
  }
  return [
    `Rewrite the following image generation prompt into the structured spec.`,
    ``,
    `Selected style (for context, do NOT include a Style/medium line in your output):`,
    styleFragment.trim(),
    ``,
    `User prompt:`,
    trimmed,
  ].join("\n");
}
