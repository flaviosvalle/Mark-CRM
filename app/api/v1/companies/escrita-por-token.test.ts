/**
 * Cadastro B2B por integração: as rotas de escrita de empresas, pessoas e
 * vínculos aceitam sessão OU Bearer com `crm:write`.
 *
 * O que não pode regredir:
 *  1. A org vem da LINHA DO TOKEN, nunca do corpo.
 *  2. `mcp:write` sozinho não escreve cadastro (403): ele envia mensagens, e o
 *     token de sincronização não deve precisar dele.
 *  3. O token respeita o rank mínimo da rota: criar exige `role:manager`.
 *  4. Token grava `created_by = null` (FK para `auth.users`) e fica no audit
 *     por `actorApiTokenId`.
 *  5. Os caminhos estão em `public-paths`, senão o proxy responde 401 antes da
 *     rota; irmãos como `/companies/lookup` continuam fora.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/crm-b2b/enrich", () => ({ enrichCompanyFromBrasilApi: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { requireRole } = await import("@/lib/auth/require-role");
const { audit } = await import("@/lib/audit");
const { isPublicPath } = await import("@/lib/auth/public-paths");
const { POST } = await import("./route");

const ORG_DO_TOKEN = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const TOKEN_ID = "44444444-4444-4444-8444-444444444444";
const UUID = "55555555-5555-4555-8555-555555555555";

function bancoDeCriacao() {
  const insercoes: Array<Record<string, unknown>> = [];
  const banco = {
    from: () => ({
      select: () => {
        const consulta = {
          eq: () => consulta,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return consulta;
      },
      insert: (dados: Record<string, unknown>) => {
        insercoes.push(dados);
        return {
          select: () => ({ single: async () => ({ data: { id: UUID, ...dados }, error: null }) }),
        };
      },
    }),
  };
  return { banco, insercoes };
}

function token(scopes: string[], role: "agent" | "manager" = "manager"): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_DO_TOKEN,
    scopes,
    role,
    actor: { type: "api_token", id: TOKEN_ID, role },
    apiTokenId: TOKEN_ID,
  } as never);
}

function post(corpo: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/companies", {
    method: "POST",
    headers: { authorization: "Bearer dsk_abc", "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

let insercoes: Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  const b = bancoDeCriacao();
  insercoes = b.insercoes;
  vi.mocked(createAdminClient).mockReturnValue(b.banco as never);
});

describe("POST /api/v1/companies por token", () => {
  it("crm:write + role:manager cria na org do token, não na do corpo", async () => {
    token(["mcp:read", "crm:write", "role:manager"]);
    const res = await POST(post({ legal_name: "Hotel Sol", organization_id: OUTRA_ORG }));
    expect(res.status).toBe(201);
    expect(insercoes).toHaveLength(1);
    expect(insercoes[0]).toMatchObject({ organization_id: ORG_DO_TOKEN, created_by: null });
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("o audit identifica o token, não um usuário", async () => {
    token(["crm:write", "role:manager"]);
    await POST(post({ legal_name: "Hotel Sol" }));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "companies.created",
        actorUserId: null,
        actorApiTokenId: TOKEN_ID,
      }),
    );
  });

  it("mcp:write sem crm:write é recusado com 403", async () => {
    token(["mcp:read", "mcp:write", "role:manager"]);
    const res = await POST(post({ legal_name: "Hotel Sol" }));
    expect(res.status).toBe(403);
    expect(insercoes).toHaveLength(0);
  });

  it("token com papel agent não cria (a rota exige manager)", async () => {
    token(["crm:write"], "agent");
    const res = await POST(post({ legal_name: "Hotel Sol" }));
    expect(res.status).toBe(403);
    expect(insercoes).toHaveLength(0);
  });
});

describe("os caminhos de cadastro passam pelo proxy", () => {
  it.each([
    "/api/v1/companies",
    `/api/v1/companies/${UUID}`,
    "/api/v1/people",
    `/api/v1/people/${UUID}`,
    "/api/v1/company-people",
    `/api/v1/company-people/${UUID}`,
    `/api/v1/contacts/${UUID}/person`,
  ])("libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    "/api/v1/companies/lookup",
    "/api/v1/companies/nao-e-uuid",
    `/api/v1/companies/${UUID}/enrich`,
    "/api/v1/people/import",
    `/api/v1/contacts/${UUID}/merge`,
  ])("não dá carona a %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});
