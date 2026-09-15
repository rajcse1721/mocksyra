window.peerSupabase = window.supabase.createClient(
  'https://qjghjsapizkqktcbczgj.supabase.co',
  'sb_publishable_LPppVZWRepW4yHykfUS2EQ_sH9dwksM',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce'
    }
  }
);
