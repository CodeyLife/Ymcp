import type { EmbeddingProvider } from "./embedding";

/**
 * 本地 Embedding Provider：基于 @huggingface/transformers (transformers.js v3+) 在浏览器内推理。
 *
 * 设计目标：
 * - 不依赖任何中转代理是否支持 
 * - 与项目"本地优先"架构（IndexedDB）一致，离线可用
 * - 懒加载 transformers.js 库与模型，避免影响首屏性能
 * - 模型从 HF 镜像（hf-mirror.com）加载，应对国内网络
 * - 复用 onnxruntime-web 的 wasm 运行时（与 superRes.worker.ts 共享）
 *
 * 模型选择：Xenova/bge-small-zh-v1.5
 * - 中文优化（项目是中文小说创作系统）
 * - 512 维，质量足够语义检索
 * - ~95MB 一次性下载，浏览器缓存后续复用
 *
 * 失败处理：pipeline 初始化或推理失败时抛错，由上游 vectorSearch（context.ts）的 .catch()
 * 降级为纯关键词检索，不阻塞核心流程。
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  name = "local-bge-small-zh-v1.5";
  dimension = 512;

  // 单例 pipeline，避免每次 embed 都重新加载模型
  private extractorPromise: Promise<unknown> | null = null;
  private initError: Error | null = null;

  // 模型与镜像配置：允许通过环境变量覆盖（VITE_EMBEDDING_MODEL / VITE_HF_MIRROR）
  private readonly modelId: string;
  private readonly remoteHost: string;

  constructor() {
    const env = import.meta.env ?? {};
    this.modelId = String(env.VITE_EMBEDDING_MODEL ?? "Xenova/bge-small-zh-v1.5");
    // hf-mirror.com 不返回 CORS 头，浏览器直连会被拦截。默认走 vite 代理的同源路径 /hf-mirror
    // （vite.config.ts 已配置转发到 https://hf-mirror.com）。
    // 生产部署需在后端反向代理 /hf-mirror/ → https://hf-mirror.com，或通过 VITE_HF_MIRROR
    // 指向已开启 CORS 的源（如 https://huggingface.co）。
    this.remoteHost = String(env.VITE_HF_MIRROR ?? "/hf-mirror");
  }

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const extractor = await this.getExtractor();
    // transformers.js pipeline 调用：pooling="mean" + normalize=true 得到归一化向量，
    // 余弦相似度计算时 cosineSimilarity 的 denom 收敛到 1，数值稳定。
    const output = await (extractor as ExtractorApi)(texts, { pooling: "mean", normalize: true });
    // output.data 是 Float32Array，按 batch 顺序展平；单条文本时 output.data 长度 === dimension
    const data = output.data as Float32Array;
    const dim = this.dimension;
    if (data.length !== texts.length * dim) {
      throw new Error(`embedding 维度不匹配：期望 ${texts.length}×${dim}=${texts.length * dim}，实际 ${data.length}`);
    }
    const result: number[][] = [];
    for (let i = 0; i < texts.length; i += 1) {
      const start = i * dim;
      result.push(Array.from(data.subarray(start, start + dim)));
    }
    return result;
  }

  /**
   * 懒加载 transformers.js + 模型 pipeline。
   * - 库本身用动态 import，避免打包进首屏 bundle
   * - 模型首次加载后由浏览器 IndexedDB/Cache 缓存，后续调用秒级返回
   * - 失败时缓存 error 避免反复重试刷日志
   */
  private async getExtractor(): Promise<unknown> {
    if (this.initError) throw this.initError;
    if (!this.extractorPromise) {
      this.extractorPromise = (async () => {
        const transformers = await import("@huggingface/transformers");
        // 配置运行时环境
        transformers.env.allowLocalModels = false; // 浏览器环境不从本地文件系统加载
        transformers.env.useBrowserCache = true; // 模型权重缓存到浏览器
        transformers.env.remoteHost = this.remoteHost;
        const pipeline = transformers.pipeline;
        const extractor = await pipeline("feature-extraction", this.modelId);
        return extractor;
      })().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.initError = new Error(
          `本地 embedding 模型加载失败（${this.modelId} @ ${this.remoteHost}）：${message}。` +
            `可检查网络或通过 VITE_EMBEDDING_MODEL / VITE_HF_MIRROR 切换模型源。`,
        );
        throw this.initError;
      });
    }
    return this.extractorPromise;
  }
}

/**
 * transformers.js feature-extraction pipeline 的最小调用签名。
 * 实际类型由 @huggingface/transformers 提供，这里只声明用到的字段以避免库类型变更影响编译。
 */
interface ExtractorApi {
  (texts: string[], options: { pooling: "mean"; normalize: boolean }): Promise<{
    data: Float32Array | number[];
  }>;
}
