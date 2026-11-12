/**
 * Quem fez a escrita no cadastro B2B: uma PESSOA (sessão) ou uma INTEGRAÇÃO
 * (token com `crm:write`).
 *
 * `created_by` é FK para `auth.users`; o id de um token não pode ir para lá
 * (o INSERT morre na FK — o mesmo defeito descrito no ator `api_token` de
 * `lib/api/handlers/types.ts`). Por isso o token grava `created_by = null` e
 * fica identificado no audit por `actor_api_token_id`.
 *
 * Os handlers aceitam também a string do id do usuário, a forma antiga, para
 * os chamadores de sessão não mudarem.
 */
export interface Autoria {
  userId: string | null;
  apiTokenId: string | null;
}

export type Autor = string | Autoria;

export function autoria(autor: Autor): Autoria {
  return typeof autor === "string" ? { userId: autor, apiTokenId: null } : autor;
}

/** Campos de autoria para `audit()`. */
export function autoriaDoAudit(autor: Autor): {
  actorUserId: string | null;
  actorApiTokenId: string | null;
} {
  const a = autoria(autor);
  return { actorUserId: a.userId, actorApiTokenId: a.apiTokenId };
}
