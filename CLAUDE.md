# frooms

How the app works is in README.md; product decisions are in CHOICES.md.

- **Pushing to `main` deploys** to https://frooms.ch (`.github/workflows/ci.yml`: tests, then `wrangler deploy` and
  `scripts/check_live.sh`). Work happens on `*-dev` branches, merged into `main` by pull request.
- **This repo is public.** Never commit secrets, personal data, or anything from the private repo (plans, infrastructure
  notes, ETH's floor plans). Secret values live in Cloudflare (Worker secrets) and GitHub (repo secrets) only.
- **CI does not apply D1 migrations.** Before pushing a commit to `main` that adds one, apply it by hand from a checkout
  of that commit (`npx wrangler d1 migrations list <db> --remote`, then `... apply <db> --remote`).
- **ETH's floor plans** aren't public until ETH agrees. `scripts/floors.sh on` copies them in from the private repo for
  local work (never commit `static/map.js`'s `FLOOR_PLANS` or `static/map/floors/index.json` then; CI's
  `scripts/check_no_floors.sh` fails on both), `scripts/floors.sh off` takes them out, `scripts/floors.sh release`
  publishes them for good.
- **Images we may not publish** (the mensa photos `static/mensa-photos/*.webp`, UZH's share backgrounds
  `assets/share-backgrounds/UZH_*`) are git-ignored and live in the private repo's `private-assets/`.
  `scripts/private_assets.sh` copies them in; CI's deploy job does that with a read-only deploy key (secret
  `FROOMS_PRIV_DEPLOY_KEY`) and stops if one is missing. `npm run deploy` runs it too.
- Plans (`plans/…` in comments) and the infrastructure notes (Cloudflare, DNS, mail, sign-in, secrets' names) are in the
  private repo `frooms-priv`, next to this checkout; `CLAUDE.local.md` (git-ignored) imports them.
