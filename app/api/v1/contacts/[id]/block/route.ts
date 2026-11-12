import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ESCOPO_ESCRITA_CRM, resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const SELECT = "id, display_name, phone_number, is_blocked, blocked_reason, blocked_at";

const bodySchema = z
  .object({
    reason: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]{1,40}$/, "Use letras minúsculas, dígitos e _ (até 40).")
      .optional(),
  })
  .strict();

/**
 * BLOQUEIA O CONTATO — o par de `unblock/route.ts`, para quem decide fora
 * da conversa.
 *
 * ## Por que esta rota existe
 *
 * O bloqueio (`is_blocked`) só nascia da INGESTÃO, por palavra-chave
 * (`lib/channels/pos-entrada.ts`). Quem guarda o "não contactar" noutro
 * sistema — um pedido por e-mail, por telefone, num formulário — não tinha
 * como fazê-lo valer aqui: `campaign_suppressions` só cobre campanhas, e o
 * motor (`before-send.ts`) só para de verdade com `is_blocked`.
 *
 * ## Por que `agent`, e o `unblock` é `admin`
 *
 * Fechar um canal a pedido do cliente é o lado seguro: qualquer atendente
 * deve poder fazê-lo. Reabrir é que pesa (direito de oposição) e continua só
 * com o admin. Pelo token, o escopo é `crm:write` — o mesmo do cadastro por
 * integração —, e o token NÃO desbloqueia: `unblock` segue só-sessão.
 *
 * ## Idempotente, sem apagar a história
 *
 * Uma integração reenvia o bloqueio em toda passagem (o pedido de "não
 * contactar" tem de se reafirmar, não só valer quando muda). Por isso:
 *   - contato JÁ bloqueado → 200, sem regravar `blocked_reason`/`blocked_at`
 *     (o motivo original, ex. `stop_keyword`, fica) e sem nova linha de audit;
 *   - contato desbloqueado → grava `is_blocked`, motivo (padrão `api`), hora,
 *     e audita `contact.blocked`.
 *
 * Não fecha negócios abertos nem cancela follow-ups — isso continua a ser
 * decisão do fluxo normal; o motor já recusa envio a contato bloqueado.
 */
export async function POST(req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contacts",
    role: "agent",
    scope: ESCOPO_ESCRITA_CRM,
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "contacts", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  let corpo: unknown = {};
  const texto = await req.text();
  if (texto.trim() !== "") {
    try {
      corpo = JSON.parse(texto);
    } catch {
      return fail("validation_failed", t("Corpo inválido."), 422, { requestId });
    }
  }
  const body = bodySchema.safeParse(corpo);
  if (!body.success) {
    return fail("validation_failed", t("Corpo inválido."), 422, {
      requestId,
      details: { issues: body.error.issues },
    });
  }

  const admin = createAdminClient();
  // Admin client bypassa RLS: o filtro por organização é PROGRAMÁTICO e
  // obrigatório (CLAUDE.md, anti-pattern 10). A org vem da sessão ou da linha
  // do token, nunca do corpo.
  const { data: gravado, error } = await admin
    .from("contacts")
    .update({
      is_blocked: true,
      blocked_reason: body.data.reason ?? "api",
      blocked_at: new Date().toISOString(),
    })
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .eq("is_blocked", false)
    .select(SELECT)
    .maybeSingle();

  if (error) {
    return fail("internal_error", t("Não foi possível bloquear o contato."), 500, { requestId });
  }

  if (!gravado) {
    // Nada mudou: ou já estava bloqueado (idempotente), ou não existe nesta org.
    const { data: atual, error: erroDeLeitura } = await admin
      .from("contacts")
      .select(SELECT)
      .eq("organization_id", authz.organizationId)
      .eq("id", id)
      .maybeSingle();
    if (erroDeLeitura) {
      return fail("internal_error", t("Não foi possível bloquear o contato."), 500, { requestId });
    }
    if (!atual) return fail("not_found", t("Contato não encontrado."), 404, { requestId });
    return ok(atual, { requestId });
  }

  // Espelha o registro do bloqueio da ingestão: mesmo `resourceType`, mesmo
  // `contact_id` no metadata, sem telefone (o `contact_id` já identifica).
  await audit({
    action: "contact.blocked",
    actorUserId: authz.via === "session" ? authz.actor.id : null,
    actorApiTokenId: authz.via === "token" ? (authz.apiTokenId ?? authz.actor.id) : null,
    organizationId: authz.organizationId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { contact_id: id, reason: gravado.blocked_reason, origem: "api" },
  });

  return ok(gravado, { requestId });
}
