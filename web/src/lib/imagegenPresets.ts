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
    label: "人物外貌锚点（轻约束）",
    fragment:
      "参考图只是一份“人脸身份档案”，不是待编辑原图，也不是姿势、服装、场景、构图或摄影风格参考。\n\n只允许读取：年龄感、肤色范围、脸型轮廓、静态五官比例、眉眼鼻唇大体结构、发色与发型大类、整体辨识气质。\n\n禁止迁移：原图表情、眼神方向、头部角度、身体姿势、手部动作、服装款式、服装颜色、配饰、背景、道具、光线方向、色温、镜头距离、构图、裁切、画幅比例、拍摄角度。\n\n必须生成一张全新的独立画面，而不是参考图的变体。除人物长相/身份辨识外，其他视觉维度都要重新抽样。若新画面描述未指定，请自由随机生成，并尽量与参考图不同：新表情、新动作/姿势、新服装/配饰、新场景/构图、新机位和新光线。\n\n最终结果应满足：人物长相可辨认为同一人，但表情、动作、姿势、服装、场景、构图、镜头和光线都明显不同。避免 reference image duplicate, same pose, same expression, same gaze, same outfit, same background, same camera angle, minor variation, redraw, image edit, face swap, second shot from same scene。\n\n新画面描述：",
    description: "只参考长相身份，其余表情、动作、服装、场景和构图强制随机重生成",
  },
  {
    id: "identity-consistency",
    label: "人物一致性",
    fragment:
      "参考图只作为人物身份和整体辨识度参考，不要逐像素复刻原图脸部特征。\n生成同一人物在新场景中的自然变化状态。\n\n保留年龄感、发型、肤色范围、脸部轮廓倾向和大致面部比例，使人物可辨识。\n表情、眼神、五官细节、头部角度、动作、姿势、服装、背景、光线和构图都应按新画面描述重新生成。\n\n新画面描述：",
    description: "参考人物身份锚定，在新画面中自然重生成",
  },
  {
    id: "same-scene-second-shot",
    label: "同场景二次拍摄",
    fragment:
      "请将参考图作为“同一人物、同一服装、同一地点、同一拍摄氛围”的连续性参考，生成一张全新的照片画面。\n\n这张图应看起来像是在同一个场景中、同一次拍摄期间拍下的另一张照片，而不是对参考图进行局部修改、重绘、修图或轻微变体。\n\n需要保持：\n- 同一个人物身份：保留参考图中人物的年龄感、脸型轮廓、五官比例、肤色范围、发型、发色和整体气质。\n- 同一套服装：服装款式、颜色、材质、层次、配饰和整体穿搭应与参考图一致。\n- 同一个场景：保留参考图中可辨识的主要环境特征、空间类型、背景风格、色调、氛围和时间感。\n- 同一种真实摄影质感：自然光影、真实镜头感、真实皮肤质感、自然景深和合理透视。\n\n需要变化：\n- 重新生成新的机位、视角、构图和镜头距离。\n- 重新生成人物的表情、眼神方向、头部角度、身体姿势、手部动作和与环境的互动。\n- 背景中的人物、物品细节和位置可以自然变化，但不能破坏“同一地点”的识别感。\n- 光线可以有自然差异，例如角度、强弱、阴影位置略有变化，但整体氛围应保持一致。\n\n画面要求：\n- 生成完整、独立、自然的新照片。\n- 不要复刻参考图的原始姿势、表情、构图或镜头角度。\n- 不要像换脸、修图、局部编辑或原图的轻微改动。\n- 保持人物身份稳定，避免脸部漂移、服装变化或场景变成另一个地点。",
    description: "保留同一地点和主体连续性，像第二次真实拍摄",
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
