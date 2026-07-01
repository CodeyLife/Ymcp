import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";
/**
 * 排除 onnxruntime-web 的 wasm 资源被打包进 dist。
 *
 * onnxruntime-web 在 build 时会被 Vite 检测到 wasm 引用并拷贝到 dist/assets，
 * 但运行时 superRes.worker.ts 已通过 ort.env.wasm.wasmPaths 指向 CDN，
 * dist 里的 wasm 文件根本不会被加载。删除可减少 ~24MB 产物体积。
 */
function excludeOnnxWasm() {
    return {
        name: "exclude-onnx-wasm",
        enforce: "post",
        generateBundle(_options, bundle) {
            for (const key of Object.keys(bundle)) {
                if (key.endsWith(".wasm"))
                    delete bundle[key];
            }
        },
    };
}
/**
 * 从 src/config/defaults.ts 解析 DEFAULT_BASE_URL，避免在 vite.config 中重复维护默认值。
 * vite.config 属于构建期（独立 TS 项目），无法静态 import src/ 下的文件，
 * 故在配置加载时通过 fs 读取该唯一来源。
 */
function readDefaultBaseUrl() {
    const src = readFileSync(path.resolve(__dirname, "src/config/defaults.ts"), "utf8");
    const match = src.match(/DEFAULT_BASE_URL\s*=\s*"([^"]+)"/);
    if (!match)
        throw new Error("无法从 src/config/defaults.ts 解析 DEFAULT_BASE_URL");
    return match[1];
}
const DEV_PROXY_TARGET = new URL(readDefaultBaseUrl()).origin;
export default defineConfig({
    plugins: [react(), excludeOnnxWasm()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    optimizeDeps: {
        exclude: ["onnxruntime-web"],
    },
    server: {
        port: 5173,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:7000",
                changeOrigin: true,
            },
            "/ai-proxy": {
                target: DEV_PROXY_TARGET,
                changeOrigin: true,
                secure: false,
                rewrite: (p) => p.replace(/^\/ai-proxy/, "/v1"),
            },
        },
    },
    build: {
        target: "esnext",
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (!id.includes("node_modules"))
                        return undefined;
                    if (/[\\/]node_modules[\\/](\.pnpm[\\/])?(react|react-dom|react-router-dom|scheduler)[\\/]/.test(id)) {
                        return "vendor-react";
                    }
                    if (/[\\/]node_modules[\\/](\.pnpm[\\/])?(antd|@ant-design|rc-[^\\/]+)[\\/]/.test(id)) {
                        return "vendor-antd";
                    }
                    if (id.includes("motion")) {
                        return "vendor-motion";
                    }
                    if (id.includes("@tanstack")) {
                        return "vendor-query";
                    }
                    if (id.includes("zustand") || id.includes("axios")) {
                        return "vendor-state";
                    }
                    return undefined;
                },
            },
        },
    },
});
