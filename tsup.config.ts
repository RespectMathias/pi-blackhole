import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  outDir: "dist",
  bundle: true,
  splitting: false,
  dts: false,
  clean: true,
  treeshake: true,
  sourcemap: true,
  target: "es2022",
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/compat",
    "@earendil-works/pi-tui",
    "typebox",
    "@sinclair/typebox",
  ],
});
