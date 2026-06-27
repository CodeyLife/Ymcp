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
});
