import { createDefaultEsmPreset } from "ts-jest";

const preset = createDefaultEsmPreset({
  tsconfig: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    allowImportingTsExtensions: true,
    esModuleInterop: true,
  },
});

export default {
  ...preset,
  testMatch: ["<rootDir>/test/**/*.test.{ts,mjs}"],
};
