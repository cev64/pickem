// sync-results: copies kickoffs, scores and winners from the site's
// data/results.json (refreshed daily by the "Update game results" GitHub
// Action) into public.games, so picks lock at kickoff and group
// leaderboards can grade them. Runs hourly from pg_cron; safe to call any time.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const RESULTS_URL = Deno.env.get("RESULTS_URL") ?? "https://bracketeersports.com/data/results.json";

Deno.serve(async () => {
  try {
    const res = await fetch(`${RESULTS_URL}?t=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`results.json: HTTP ${res.status}`);
    const payload = await res.json();
    if (!Array.isArray(payload?.games)) throw new Error("results.json has no games array");

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    const { data, error } = await db.rpc("sync_results", { payload });
    if (error) throw error;

    return Response.json({ ok: true, changed: data, source_updated: payload.updated ?? null });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String((e as Error)?.message ?? e) }, { status: 500 });
  }
});
