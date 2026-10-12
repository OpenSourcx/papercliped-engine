import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { devEngine } from "./scripts/devEngine.ts";

export default defineConfig({
  // devEngine is dev-server only and off unless EPC_DEV_ENGINE is set; see scripts/devEngine.ts.
  plugins: [react(), tailwindcss(), devEngine()],
  server: { host: "127.0.0.1", port: 5173 },
});
