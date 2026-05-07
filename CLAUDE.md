# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev           # Start Vite dev server (localhost:5173)
pnpm dev:init      # Initialize development environment (first-time setup)
pnpm build         # Production build
pnpm preview       # Preview production build locally
pnpm release       # Build and deploy to Cloudflare Workers
pnpm check         # Generate Wrangler types + TypeScript type check
pnpm types         # TypeScript type check only
pnpm clean         # Clean Vite cache
```

No test runner or linter is configured in this project.

## Architecture

This is a **RedwoodSDK** app running on **Cloudflare Workers**, not a standard Next.js app. The folder name is misleading.

**Entry points:**
- `src/worker.tsx` — Server entry point. Defines the app with `defineApp()`, registers routes, and applies middleware. This is where routes and `AppContext` are configured.
- `src/client.tsx` — Client hydration script. Bootstraps RSC (React Server Components) RPC for client-side navigation.

**Routing** is declared in `src/worker.tsx` using `route("/path", Component)`. To add a new page, add a route here and create the corresponding component under `src/app/pages/`.

**React Server Components** are the default. Only components with `"use client"` at the top become client components. Prefer server components for data fetching; use client components only when you need browser APIs or React hooks.

**Server Functions** (RSC RPC) replace traditional API routes. There are no API routes currently — data fetching is done directly in server components.

**Type-safe routing** uses `link` from `src/app/shared/links.ts`, which wraps `linkFor<App>()`. Always use this instead of raw strings for internal links.

**Environment/config:** No `.env` files — Cloudflare secrets and vars are configured in `wrangler.jsonc` under `vars`. Sensitive values for local dev go in `.dev.vars` (gitignored).

**Path alias:** `@/*` maps to `./src/*`.

## Key Conventions

- Security headers (CSP, HSTS, etc.) are applied via middleware in `src/app/headers.ts`. The CSP uses a nonce for inline scripts — don't add inline scripts without wiring them to the nonce.
- CSS modules (`.module.css`) are used for component-scoped styles.
- The worker name in `wrangler.jsonc` is `__change_me__` — update before deploying to production.
