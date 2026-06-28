import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    server: {
        port: 5173,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:7000",
                changeOrigin: true,
            },
            "/ai-proxy": {
                target: "https://image.yujin8.top",
                changeOrigin: true,
                secure: false,
                rewrite: (p) => p.replace(/^\/ai-proxy/, "/v1"),
            },
        },
    },
    build: {
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
