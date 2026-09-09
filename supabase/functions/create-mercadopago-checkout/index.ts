import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const mpAccessToken = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");

    if (!mpAccessToken) return json({ error: "MERCADO_PAGO_ACCESS_TOKEN não configurado." }, 500);

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    const user = userData?.user;
    if (userError || !user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceRole);
    const { data: settings, error: settingsError } = await admin
      .from("app_settings")
      .select("pro_enabled,pro_price_brl,pro_duration_days")
      .eq("id", "main")
      .single();

    if (settingsError || !settings) throw settingsError || new Error("Configuração não encontrada.");
    if (!settings.pro_enabled) return json({ error: "Plano PRO está desativado." }, 409);

    const price = Number(settings.pro_price_brl);
    const days = Number(settings.pro_duration_days);
    const webhookUrl = `${supabaseUrl}/functions/v1/mercadopago-webhook`;
    const appReturnUrl = Deno.env.get("APP_RETURN_URL") || "";

    const preference: Record<string, unknown> = {
      items: [{
        id: "insta-analytics-pro",
        title: `Insta Analytics PRO - ${days} dias`,
        description: "Acesso ao plano PRO do Insta Analytics",
        quantity: 1,
        currency_id: "BRL",
        unit_price: price
      }],
      payer: user.email ? { email: user.email } : undefined,
      external_reference: user.id,
      notification_url: webhookUrl,
      metadata: {
        user_id: user.id,
        plan_code: "pro",
        duration_days: days
      }
    };

    if (appReturnUrl.startsWith("https://")) {
      preference.back_urls = {
        success: appReturnUrl,
        pending: appReturnUrl,
        failure: appReturnUrl
      };
      preference.auto_return = "approved";
    }

    const mpResponse = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mpAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(preference)
    });

    const mpData = await mpResponse.json().catch(() => ({}));

    if (!mpResponse.ok) {
      console.error("Mercado Pago preference error", mpData);
      return json({
        error: "Falha ao criar checkout no Mercado Pago.",
        details: mpData
      }, 502);
    }

    return json({
      preference_id: mpData.id,
      checkout_url: mpData.init_point,
      sandbox_checkout_url: mpData.sandbox_init_point,
      price_brl: price,
      duration_days: days
    });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "internal_error" }, 500);
  }
});

