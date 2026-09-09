window.InstaAnalytics = window.InstaAnalytics || {};

window.InstaAnalytics.productDefaults = {
  guest_enabled: true,
  guest_collection_limit: 10,

  free_enabled: false,
  free_monthly_collection_limit: 10,

  pro_enabled: true,
  pro_unlimited: false,
  pro_monthly_collection_limit: 100,
  pro_price_brl: 19.90,
  pro_duration_days: 30,

  collection_cooldown_minutes: 0,

  // Diffs confiáveis: a mudança precisa persistir na coleta seguinte.
  diff_confirmation_runs: 2
};
