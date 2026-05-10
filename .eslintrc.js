module.exports = {
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "./tsconfig.json",
    sourceType: "module",
    extraFileExtensions: [".json"],
  },
  ignorePatterns: [".eslintrc.js", "dist/**/*", "node_modules/**/*", "gulpfile.js"],
  overrides: [
    {
      files: ["package.json"],
      plugins: ["eslint-plugin-n8n-nodes-base"],
      extends: ["plugin:n8n-nodes-base/community"],
      // package.json n'est pas un fichier TS — on désactive le parser
      // typescript-eslint pour éviter l'erreur "TSConfig does not include this file".
      parser: "espree",
      parserOptions: { project: null, ecmaVersion: 2022 },
    },
    {
      files: ["./credentials/**/*.ts"],
      plugins: ["eslint-plugin-n8n-nodes-base"],
      extends: ["plugin:n8n-nodes-base/credentials"],
    },
    {
      files: ["./nodes/**/*.ts"],
      plugins: ["eslint-plugin-n8n-nodes-base"],
      extends: ["plugin:n8n-nodes-base/nodes"],
    },
  ],
};
