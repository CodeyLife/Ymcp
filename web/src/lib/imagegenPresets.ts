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
      `请把参考图作为“同一人物身份锚点”，而不是拍摄模板。生成该人物在全新拍摄状态下的独立照片，而不是原图编辑、局部重绘、相邻帧或同角度复刻。

核心目标：只保持同一人物的整体辨识度，让人物能被认出是参考图中的同一个人；新照片的服装、地点、姿势、动作、表情、视线、机位、构图、光线和背景应根据新画面描述重新生成。

保持：年龄段、肤色范围、脸部比例印象、整体气质、发型大类和人物身份识别度。不要逐项复刻参考图的五官细节、脸部角度、发丝轮廓或微表情。

重新生成：服装、地点、身体姿势、肩颈方向、头部朝向、手部动作、表情、视线方向、镜头距离、拍摄角度、构图重心、光线关系和背景空间。除非新画面描述明确要求，否则不要延续参考图的服装、地点、姿势、动作、机位、构图或光线。

默认主动变化：当新画面描述没有指定服装、地点、动作、表情或机位时，请主动选择明显不同于参考图的自然方案，让画面像另一次真实拍摄。

反复制要求：不要复制参考图的脸部角度、发丝轮廓、身体姿势、手部位置、构图、背景布局或光线关系。

最终画面应像同一人物在新地点、新动作、新服饰、新机位下拍摄的新照片：身份稳定，拍摄状态明显不同，自然可信。

新画面描述：`,
    description: "保持同一人物识别度，但强制变化姿势、动作、朝向、机位、场景和自然发丝状态",
  },
  {
    id: "same-scene-second-shot",
    label: "同场景二次拍摄",
    fragment:
      `请把参考图作为“三要素连续性参考”（人物、服装、地点），生成同一人物在同一处或附近环境下拍摄的另一张独立照片。

保持识别度：
- 人物：年龄段、肤色范围、脸部比例印象、发色范围、发型大类、整体气质和身份识别度。
- 服装：同一套服装的款式、主色、材质、层次、配饰和穿搭识别度。
- 地点：同一处或附近环境的空间类型、主要环境元素、背景风格、色调和真实摄影质感。

重新选择：人物在场景中的位置、朝向、头部角度、姿势、动作、手部动作、表情、眼神方向、机位、镜头距离、构图、裁切和画面重心。可让人物与环境产生新互动（走动、回头、侧身、坐下、倚靠、整理衣物、与道具互动）。背景局部细节和光线可以自然变化，但仍应能看出是同一处或附近环境。

画面应像同一人物穿着同一套服装，在同一个地点附近拍摄的全新照片，而非原图的变体、换脸、局部重绘或连拍。不要复制原图构图、脸部角度、发丝轮廓、手部位置或背景像素布局。

新画面描述：`,
    description: "保留人物、服装和地点，但禁止发丝/相邻帧复刻并强制重选位置、姿势、表情、动作和机位",
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
