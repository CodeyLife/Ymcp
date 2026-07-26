// 默认 API 配置
// TODO P1：此 URL 与 ai.ts DEV_PROXY_BASE_URL、service.ts 默认 baseUrl 三处硬编码同步，
// 任一处变更会破坏 ai.ts endpoint() 字符串等式判定。应集中到单一 config 并由其他模块导入。
export const DEFAULT_BASE_URL = "https://chat.yujin8.top/v1";
// 可选的部署级共享 Key。VITE_* 会进入浏览器产物，不应把它当作服务端秘密。
const buildEnv = import.meta.env ?? {};
export const DEFAULT_API_KEY = String(buildEnv.VITE_DEFAULT_API_KEY ?? "").trim();

// 默认提示词模板：用户未配置（留空）时使用
export const DEFAULT_GREENSCREEN_PROMPT =
  "Pure chroma key green background (#00FF00), no shadows, no gradients, no highlights，background=opaque";
export const DEFAULT_SPRITESHEET_PROMPT =
  "A seamless sprite sheet animation arranged in a grid layout, consisting of multiple frames showing sequential motion, each frame evenly spaced in a regular grid, consistent character scale and positioning, transparent or uniform background, clear visual progression of movement, designed for frame-by-frame animation extraction";
