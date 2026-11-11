const { defineConfig } = require("vite");

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];

module.exports = defineConfig({
  base: process.env.GITHUB_ACTIONS === "true" && repositoryName
    ? `/${repositoryName}/`
    : "/",
});
