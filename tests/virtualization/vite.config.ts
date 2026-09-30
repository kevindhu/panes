import { defineConfig, mergeConfig } from "vite";
import base from "../../vite.config";
export default mergeConfig(base, defineConfig({ server: { port: 1430, hmr: false } }));
