# CI workflow

`ci.yml.disabled` contains the complete GitHub Actions pipeline: strict TypeScript, ESLint, Prettier, the full Vitest suite with coverage, the extension and resolver builds, distribution validation, and packaging of unconfigured QA artifacts.

It ships with the `.disabled` suffix because the repository was published with a GitHub CLI token that did not carry the `workflow` OAuth scope, and GitHub refuses to create files under `.github/workflows/` without it.

## Activating it

1. Grant the scope once:

   ```bash
   gh auth refresh -h github.com -s workflow
   ```

2. Rename the file back:

   ```bash
   git mv .github/workflows/ci.yml.disabled .github/workflows/ci.yml
   git commit -m "ci: enable GitHub Actions pipeline"
   git push
   ```

Alternatively, rename it in the GitHub web editor; no local command is required.

Until then, run the same gates locally with:

```bash
npm ci
npm run check
```

`npm run check` executes typecheck, lint, format check, tests, the extension build, the resolver build, and `validate:dist` in the same order as CI.
