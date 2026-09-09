import { createClient } from "npm:@supabase/supabase-js@2";

function textEncoder(value: string) {
  return new TextEncoder().encode(value);
}

function toHex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function validateSignature(
  req: Request,
  dataId: string,
  secret: string
) {
  const signature = req.headers.get("x-signature") || "";
  const requestId = req.headers.get("x-request-id") || "";

  const parts = Object.fromEntries(
    signature
      .split(",")
      .map((part) => part.trim().split("="))
      .filter((part) => part.length === 2)
  );

  const ts = String(parts.ts || "");
  const v1 = String(parts.v1 || "");

  console.log("[MP WEBHOOK] signature diagnostics", {
    hasSignature: Boolean(signature),
    hasRequestId: Boolean(requestId),
    hasTimestamp: Boolean(ts),
    hasV1: Boolean(v1),
    hasSecret: Boolean(secret),
    dataId
  });

  if (!ts || !v1) {
    return {
      valid: false,
      reason: "missing_signature_parts"
    };
  }

  let manifest = "";

  if (dataId) {
    manifest += `id:${dataId.toLowerCase()};`;
  }

  if (requestId) {
    manifest += `request-id:${requestId};`;
  }

  manifest += `ts:${ts};`;

  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder(manifest)
  );

  const calculated = toHex(digest);
  const valid = safeEqual(calculated, v1);

  console.log("[MP WEBHOOK] signature result", {
    valid,
    manifest
  });

  return {
    valid,
    reason: valid ? "ok" : "signature_mismatch"
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

Deno.serve(async (req) => {
  console.log("[MP WEBHOOK] ===== REQUEST RECEBIDO =====", {
    method: req.method,
    url: req.url
  });

  if (req.method !== "POST") {
    return response({ ok: true }, 200);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const mpAccessToken =
      Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN") || "";
    const webhookSecret =
      Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET") || "";

    if (!mpAccessToken || !webhookSecret) {
      console.error("[MP WEBHOOK ERROR] secrets ausentes", {
        hasAccessToken: Boolean(mpAccessToken),
        hasWebhookSecret: Boolean(webhookSecret)
      });

      return response(
        { error: "server_not_configured" },
        500
      );
    }

    let body: any = {};

    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const url = new URL(req.url);

    const queryDataId =
      url.searchParams.get("data.id") ||
      url.searchParams.get("data_id") ||
      "";

    const bodyDataId = body?.data?.id || "";

    const dataId = String(
      queryDataId ||
      bodyDataId ||
      ""
    );

    const queryType =
      url.searchParams.get("type") || "";

    const type = String(
      body?.type ||
      queryType ||
      ""
    );

    console.log("[MP WEBHOOK] payload", {
      type,
      action: body?.action || null,
      dataId,
      queryDataId,
      bodyDataId,
      liveMode: body?.live_mode ?? null
    });

    const signatureResult = await validateSignature(
      req,
      dataId,
      webhookSecret
    );

    if (!signatureResult.valid) {
      console.error(
        "[MP WEBHOOK ERROR] assinatura inválida",
        {
          reason: signatureResult.reason,
          dataId
        }
      );

      return response(
        {
          error: "invalid_signature",
          reason: signatureResult.reason
        },
        401
      );
    }

    console.log("[MP WEBHOOK] assinatura válida");

    if (!dataId) {
      console.log("[MP WEBHOOK] ignorado: sem dataId");
      return response({
        ok: true,
        ignored: "missing_data_id"
      });
    }

    if (type && type !== "payment") {
      console.log(
        "[MP WEBHOOK] ignorado: evento não é payment",
        { type }
      );

      return response({
        ok: true,
        ignored: "not_payment",
        type
      });
    }

    console.log(
      "[MP WEBHOOK] consultando pagamento",
      { paymentId: dataId }
    );

    const paymentResponse = await fetch(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(dataId)}`,
      {
        headers: {
          Authorization: `Bearer ${mpAccessToken}`
        }
      }
    );

    const payment =
      await paymentResponse.json().catch(() => ({}));

    if (!paymentResponse.ok) {
      console.error(
        "[MP WEBHOOK ERROR] payment lookup",
        {
          status: paymentResponse.status,
          payment
        }
      );

      return response(
        { error: "payment_lookup_failed" },
        502
      );
    }

    console.log("[MP WEBHOOK] pagamento encontrado", {
      id: payment.id,
      status: payment.status,
      amount: payment.transaction_amount,
      currency: payment.currency_id,
      externalReference: payment.external_reference,
      metadataUserId: payment.metadata?.user_id
    });

    const userId = String(
      payment.external_reference ||
      payment.metadata?.user_id ||
      ""
    );

    if (!userId) {
      console.error(
        "[MP WEBHOOK ERROR] pagamento sem userId"
      );

      return response({
        ok: true,
        ignored: "missing_user_reference"
      });
    }

    const admin = createClient(
      supabaseUrl,
      serviceRole
    );

    const {
      data: settings,
      error: settingsError
    } = await admin
      .from("app_settings")
      .select("pro_price_brl,pro_duration_days")
      .eq("id", "main")
      .single();

    if (settingsError || !settings) {
      throw settingsError ||
        new Error("Configuração não encontrada.");
    }

    const expectedAmount =
      Number(settings.pro_price_brl);

    const amount =
      Number(payment.transaction_amount || 0);

    const currency =
      String(payment.currency_id || "");

    const amountMatches =
      Math.abs(amount - expectedAmount) < 0.01 &&
      currency === "BRL";

    console.log("[MP WEBHOOK] validação financeira", {
      amount,
      expectedAmount,
      currency,
      amountMatches
    });

    const {
      data: existing,
      error: existingError
    } = await admin
      .from("payments")
      .select("*")
      .eq(
        "provider_payment_id",
        String(payment.id)
      )
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    const status =
      String(payment.status || "unknown");

    const {
      error: paymentUpsertError
    } = await admin
      .from("payments")
      .upsert(
        {
          user_id: userId,
          provider: "mercadopago",
          provider_payment_id:
            String(payment.id),
          status,
          amount,
          currency,
          credited_days:
            existing?.credited_days || 0,
          credited_at:
            existing?.credited_at || null,
          reversed_at:
            existing?.reversed_at || null,
          raw: payment,
          updated_at:
            new Date().toISOString()
        },
        {
          onConflict: "provider_payment_id"
        }
      );

    if (paymentUpsertError) {
      console.error(
        "[MP WEBHOOK ERROR] payments upsert",
        paymentUpsertError
      );

      throw paymentUpsertError;
    }

    console.log(
      "[MP WEBHOOK] pagamento salvo em payments"
    );

    if (
      status === "approved" &&
      amountMatches &&
      !existing?.credited_at
    ) {
      console.log(
        "[MP WEBHOOK] pagamento elegível para PRO"
      );

      const {
        data: subscription,
        error: subscriptionReadError
      } = await admin
        .from("subscriptions")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (subscriptionReadError) {
        throw subscriptionReadError;
      }

      const now = new Date();

      const currentPaidUntil =
        subscription?.paid_until
          ? new Date(subscription.paid_until)
          : null;

      const base =
        currentPaidUntil &&
        currentPaidUntil > now
          ? currentPaidUntil
          : now;

      const days =
        Number(
          settings.pro_duration_days || 30
        );

      const newPaidUntil =
        new Date(
          base.getTime() +
          days * 86_400_000
        );

      const {
        error: subscriptionUpsertError
      } = await admin
        .from("subscriptions")
        .upsert(
          {
            user_id: userId,
            plan_code: "pro",
            status: "active",
            provider: "mercadopago",
            paid_until:
              newPaidUntil.toISOString(),
            provider_payer_id:
              payment.payer?.id
                ? String(payment.payer.id)
                : null,
            updated_at:
              new Date().toISOString()
          },
          {
            onConflict: "user_id"
          }
        );

      if (subscriptionUpsertError) {
        console.error(
          "[MP WEBHOOK ERROR] subscription upsert",
          subscriptionUpsertError
        );

        throw subscriptionUpsertError;
      }

      console.log(
        "[MP WEBHOOK] PRO ATIVADO",
        {
          userId,
          days,
          paidUntil:
            newPaidUntil.toISOString()
        }
      );

      const {
        error: creditError
      } = await admin
        .from("payments")
        .update({
          credited_days: days,
          credited_at:
            new Date().toISOString(),
          updated_at:
            new Date().toISOString()
        })
        .eq(
          "provider_payment_id",
          String(payment.id)
        );

      if (creditError) {
        throw creditError;
      }

      console.log(
        "[MP WEBHOOK] pagamento creditado"
      );
    } else {
      console.log(
        "[MP WEBHOOK] pagamento não creditado",
        {
          status,
          amountMatches,
          alreadyCredited:
            Boolean(existing?.credited_at)
        }
      );
    }

    console.log(
      "[MP WEBHOOK] ===== FINALIZADO ====="
    );

    return response({
      ok: true,
      payment_id: String(payment.id),
      status
    });

  } catch (error) {
    console.error(
      "[MP WEBHOOK ERROR] exceção",
      error
    );

    return response(
      {
        error:
          error instanceof Error
            ? error.message
            : "internal_error"
      },
      500
    );
  }
});
