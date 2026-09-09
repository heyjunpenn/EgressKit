import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
