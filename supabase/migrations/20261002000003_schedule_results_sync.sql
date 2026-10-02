-- Call the sync-results edge function every hour (at :07), so kickoffs,
-- scores and winners in public.games follow data/results.json.
-- The bearer token is the project's public anon key (it's already in index.html).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'sync-results-hourly',
  '7 * * * *',
  $$
  select net.http_post(
    url     := 'https://zvsldzvialssswvvmkgk.supabase.co/functions/v1/sync-results',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp2c2xkenZpYWxzc3N3dnZta2drIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5NTc0ODQsImV4cCI6MjEwNjUzMzQ4NH0.vL0hBwPbqWmQQ4yySWsT6Gx_nxAk9EhNGSOM-i23fDI'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);
