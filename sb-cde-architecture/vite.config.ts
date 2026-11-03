import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = Number(process.env.API_PORT ?? 3001);
const webPort = Number(process.env.PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: Boolean(process.env.PORT),
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
});
