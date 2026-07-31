// Conventional Commits enforced on commit-msg via husky.
// See: https://www.conventionalcommits.org/
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      1,
      "always",
      ["indexer", "web", "contracts", "shared", "infra", "docs", "ci", "deps", "repo"],
    ],
  },
};
