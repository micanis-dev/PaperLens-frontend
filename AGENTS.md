# Agent deployment guardrails

Before changing or deploying infrastructure, read `DEPLOYMENT.md` completely.

- This repository owns only the Cloudflare Worker frontend named `paperlens`.
- Always work from this repository root; the parent directory is not a Git repository.
- Use `pnpm run deploy:dry-run` before `pnpm run deploy`.
- Never use Cloudflare Pages for PaperLens and never target another project.
- Never run Fly.io or Supabase deployment commands here.
- Verify Git remote, branch, target name, public HTML, and deployment status.
- If any target differs from `DEPLOYMENT.md`, stop instead of improvising.
