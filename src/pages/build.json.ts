// Tells /admin which commit the live site was built from, so "Published ✓"
// only shows once the new version is actually being served.
// COMMIT_REF is set by Netlify during the build.
export const prerender = true;

export function GET() {
  return new Response(
    JSON.stringify({ commit: process.env.COMMIT_REF || null, builtAt: new Date().toISOString() }),
    { headers: { "content-type": "application/json" } }
  );
}
