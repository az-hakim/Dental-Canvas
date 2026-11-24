/**
 * Placeholder, replaced during the build.
 *
 * `npm run vercel-build` runs `scripts/build-api.mjs`, which bundles
 * `src/server/vercel-entry.ts` over this file. It cannot be the only copy:
 * Vercel validates the `functions` pattern in vercel.json *before* it runs the
 * build command, so `api/index.mjs` has to exist in the repository or every
 * Git-triggered deploy dies with `[unused_function]` in two seconds.
 *
 * If you are reading this in a checkout, run the build before a
 * `vercel deploy --prebuilt`; never commit the generated bundle.
 */
export default {
  fetch: () => new Response("Dental Canvas API was not built", { status: 503 }),
};
