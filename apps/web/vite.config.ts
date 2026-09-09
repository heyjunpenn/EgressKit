import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@phosphor-icons")) return "icons";
          if (id.includes("@tanstack/react-virtual")) return "table";
          if (id.includes("motion") || id.includes("framer-motion")) return "motion";
          if (id.includes("react") || id.includes("scheduler")) return "react";
        },
      },
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    proxy: {
      "/live": "http://127.0.0.1:8787",
      "/console": "http://127.0.0.1:8787",
      "/metrics": "http://127.0.0.1:8787",
      "/nodes": "http://127.0.0.1:8787",
      "/operations": "http://127.0.0.1:8787",
      "/ready": "http://127.0.0.1:8787",
      "/revisions": "http://127.0.0.1:8787",
      "/subscriptions": "http://127.0.0.1:8787",
    },
  },
});
