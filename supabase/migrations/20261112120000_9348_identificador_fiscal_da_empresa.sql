-- manifest: **Identificador fiscal genérico da empresa (`tax_id` + `tax_id_country`).** O cadastro B2B só conhecia o CNPJ; empresa de outro país (ex.: NIF/NIPC português) não tinha onde guardar o documento nem como evitar duplicata. Duas colunas nulas em `companies`, país em ISO alfa-2, documento só [0-9A-Z] sem máscara e obrigatório com país; índice único parcial por (organização, país, documento). A validação por país (PT: 9 dígitos com dígito de controle) mora na API. Aditiva: nenhuma linha existente muda; apêndice idempotente no fim do `baseline.sql`.
-- ============================================================================
-- 9348 — IDENTIFICADOR FISCAL GENÉRICO DA EMPRESA.
--
-- `companies.cnpj` serve o Brasil. Uma organização de outro país cadastrava a
-- empresa sem documento, e a sincronização com outro sistema não tinha chave
-- fiscal para casar a mesma empresa nos dois lados. `tax_id` guarda o documento
-- sem máscara e `tax_id_country` diz qual régua o valida. O CNPJ não migra para
-- cá: continua nas colunas dele e no enriquecimento da BrasilAPI.
-- ============================================================================

alter table public.companies
  add column if not exists tax_id text;

alter table public.companies
  add column if not exists tax_id_country text;

comment on column public.companies.tax_id is
  'Identificador fiscal da empresa fora do Brasil (ex.: NIF/NIPC português), só dígitos e letras, sem máscara. Validado na API pela régua do país em tax_id_country (validarIdentificadorFiscal em lib/legal/perfil-do-pais.ts). O CNPJ continua em cnpj/normalized_cnpj; o enriquecimento da BrasilAPI só usa o CNPJ.';

comment on column public.companies.tax_id_country is
  'País (ISO 3166-1 alfa-2, maiúsculas) que emitiu tax_id. Obrigatório quando tax_id está preenchido.';

-- Constraints em bloco: `add constraint` não tem `if not exists`, e o update.sh
-- (sem ON_ERROR_STOP) reaplica este trecho em banco que já as tem. As colunas
-- nascem nulas, então nenhum dado existente as viola.
do $identificador_fiscal$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.companies'::regclass
       and conname = 'companies_tax_id_country_iso'
  ) then
    alter table public.companies
      add constraint companies_tax_id_country_iso
      check (tax_id_country is null or tax_id_country ~ '^[A-Z]{2}$');
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.companies'::regclass
       and conname = 'companies_tax_id_com_pais'
  ) then
    alter table public.companies
      add constraint companies_tax_id_com_pais
      check (tax_id is null or (tax_id_country is not null and tax_id ~ '^[0-9A-Z]{1,32}$'));
  end if;
end
$identificador_fiscal$;

create unique index if not exists companies_org_tax_id_uidx
  on public.companies (organization_id, tax_id_country, tax_id)
  where tax_id is not null;

notify pgrst, 'reload schema';
