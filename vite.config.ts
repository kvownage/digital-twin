import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// O cliente fala sempre com a MESMA origem: em dev o Vite faz proxy do
// WebSocket para o servidor Node; em produção o Node serve o build e o WS
// já é da própria origem. O código do cliente não muda entre os dois.
export default defineConfig({
  root: "client",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
