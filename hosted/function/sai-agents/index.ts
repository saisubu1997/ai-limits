// Serves the published single-file app as real HTML.
// Storage deliberately returns text/plain (no rendering), so this function is
// what makes a https://<ref>.supabase.co URL work in a browser.
const OBJECT = "app/sai-agents.html";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/health")) return new Response("ok");

  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const res = await fetch(`${base}/storage/v1/object/public/${OBJECT}`, {
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) {
    return new Response("Publish the app first: ./host-supabase.sh", { status: 502 });
  }
  return new Response(await res.text(), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
});
