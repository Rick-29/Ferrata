import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig } from "vite"

// Ferrata website: landing, sign-in, profile and the dashboard with the embedded wallet.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@sqw/brand": path.resolve(__dirname, "../brand/src/index.ts"),
    },
  },
  server: { port: 5174, strictPort: true },
})
