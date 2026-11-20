import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the built board works from any static host or subpath.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
