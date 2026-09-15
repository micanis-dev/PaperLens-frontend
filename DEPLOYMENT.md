# PaperLens frontend deployment runbook

This repository deploys the PaperLens static frontend to a **Cloudflare Worker**.
It does not deploy to Cloudflare Pages, Fly.io, or Supabase.

## Fixed production target

| Item | Required value |
| --- | --- |
| Working directory | Repository root containing this file |
| Git repository | `micanis-dev/PaperLens-frontend` |
| Git branch | `main` |
| Cloudflare product | Workers with static assets |
| Worker name | `paperlens` |
| Custom domain | `paperlens.micanis.dev` |
| Build output | `dist` |
| API origin | `https://api.paperlens.micanis.dev` |
| Wrangler config | `wrangler.jsonc` |

The production target is defined in `wrangler.jsonc`. Do not override the
Worker name or deploy target on the command line.

## Preflight: stop on any mismatch

Run every command from this repository, never from the parent `PaperLens`
directory.

```sh
test "$(basename "$PWD")" = "frontend"
test -f wrangler.jsonc
test "$(git remote get-url origin)" = "https://github.com/micanis-dev/PaperLens-frontend.git"
test "$(git branch --show-current)" = "main"
git status --short --branch
pnpm exec wrangler whoami
```

Stop if the working tree contains changes you do not understand. Never discard
someone else's changes to make a deployment pass.

## Validate and deploy

Use only the repository scripts. `build.static` deliberately performs the
client build before SSG; running only the adapter build can mix stale assets and
produce a broken deployment.

```sh
pnpm install --frozen-lockfile
pnpm run build.types
pnpm run lint
pnpm run test:e2e
pnpm run deploy:dry-run
pnpm run deploy
```

`pnpm run deploy` builds again before calling the repository-local Wrangler.

## Required verification

```sh
curl -fsS https://paperlens.micanis.dev/ | grep -F 'PaperLens'
curl -fsS https://paperlens.micanis.dev/papers/deployment-check/ | grep -F 'PaperLens'
curl -fsS https://api.paperlens.micanis.dev/v1/healthz
pnpm exec wrangler deployments list --name paperlens
```

The first two requests must return the frontend HTML. An authentication JSON
error from `/` means the frontend Worker was replaced by an API deployment.

## Rollback

List versions and select the last known-good **frontend** version. Do not guess
a version ID.

```sh
pnpm exec wrangler versions list --name paperlens
pnpm exec wrangler rollback <KNOWN_GOOD_VERSION_ID> --name paperlens
```

Repeat all verification commands after rollback.

## Forbidden operations

- Do not run any deployment command from the parent `PaperLens` directory.
- Do not use `wrangler pages deploy`; PaperLens frontend is a Worker.
- Do not deploy to `ai-system-open-campus` or any other Pages project.
- Do not pass `--name` or a different config file to `pnpm run deploy`.
- Do not upload an existing `dist` without rebuilding it.
- Do not run `fly deploy` or `supabase db push` from this repository.
- Do not delete Workers, Pages projects, deployments, domains, or DNS records
  as a troubleshooting shortcut.

Backend deployment instructions live in the backend repository's
`DEPLOYMENT.md`.
