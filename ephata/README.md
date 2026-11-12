# Mark-CRM: deploy da Ephata

Este repositório é o fork do [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM) usado pela Ephata. O desenho está em `mark-crm-parte-b.md` (Parte B do registo comercial).

## O que este fork muda

| Alteração | Onde |
| --- | --- |
| Escopo de token `crm:write` (cadastro por integração; não envia mensagens) | `lib/api/auth-dual.ts` |
| Empresas, pessoas, vínculos e contacto–pessoa aceitam token `crm:write` | `app/api/v1/companies`, `people`, `company-people`, `contacts/[id]/person` |
| Criar e editar contacto (incluindo `tags`) por token | `app/api/v1/contacts`, `contacts/[id]` |
| `POST /api/v1/contacts/:id/block` (idempotente; o token não desbloqueia) | `app/api/v1/contacts/[id]/block` |
| `tax_id` e `tax_id_country` em `companies`, NIF/NIPC validado (migração 9348) | `supabase/migrations`, `supabase/baseline.sql` |
| Telefone sem `+` segue o país da organização (PT: `+351`, nunca `+55`) | `lib/channels/phone-variants.ts`, webhook de captação |
| Imagens publicadas em `ghcr.io/flaviosvalle/*`; o kit instala estas e não as do original | `hostgator-setup-kit/_common.sh` (`IMG_NS`), `docker-compose.prod.yml` |

Os workflows do original estão desligados no GitHub deste fork, exceto **"Publicar imagem Docker (GHCR)"**. O Dependabot foi retirado.

## Versões

O kit só aceita versões numéricas `vX.Y.Z` (as etiquetas com `-` são tratadas como pré-versões e ignoradas). Convenção deste fork:

*   `X.Y` = versão do original em que o fork se baseia;
*   `Z` = **100 + n**, onde `n` conta as versões da Ephata sobre essa base.

Primeira versão: **`v1.108.100`** (original `v1.108.0~2` + patch da Ephata). Os números 100+ não colidem com as correções do original, que usam números pequenos.

### Publicar uma versão nova

No computador, com o `main` atualizado e os testes a passar:

```sh
git tag -a v1.108.101 -m "Ephata: <o que mudou>"
git push origin v1.108.101
```

No GitHub, em **Actions → Publicar imagem Docker (GHCR)**, a corrida da etiqueta tem de acabar verde (cerca de 20–30 min, amd64 e arm64). No fim, `stable` aponta para a versão nova nas quatro imagens.

### Uma vez só: imagens públicas

O GHCR cria os pacotes como **privados**, e o kit só instala imagens que consegue confirmar sem login. Depois da primeira publicação, para cada um dos quatro pacotes (`deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler`, `deskcomm-voice-agent`):

1. `https://github.com/users/flaviosvalle/packages/container/<pacote>/settings`
2. **Danger Zone → Change visibility → Public**.

O código continua privado. As imagens não têm segredos: as chaves entram pelo `.env` da VPS quando os contentores arrancam.

Para confirmar que ficou público (deve dar `200`):

```sh
for i in deskcommcrm deskcomm-worker deskcomm-scheduler deskcomm-voice-agent; do
  tok=$(curl -s "https://ghcr.io/token?scope=repository:flaviosvalle/$i:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  printf '%s ' "$i"; curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $tok" \
    -H 'Accept: application/vnd.oci.image.index.v1+json' "https://ghcr.io/v2/flaviosvalle/$i/manifests/stable"
done
```

## Instalar na VPS (CRM + Supabase alojado pela Ephata)

Decisão B2: VPS própria, separada do site, com Supabase na mesma máquina. O kit `install-single-server.sh` instala tudo: Supabase (Postgres 17, Auth, REST, Realtime, Storage), app, worker, scheduler, WAHA, Redis e HTTPS.

### Antes

*   Ubuntu 22.04/24.04, **8 GB de RAM recomendados** (o kit aceita a partir de cerca de 4 GB), 2 vCPU, disco de 40 GB ou mais.
*   DNS: registo `A` de `crm.ephata.pt` para o IP da VPS. Portas 80 e 443 abertas.
*   Imagens da versão já publicadas e públicas (secção anterior).

### Acesso ao repositório privado (chave de deploy só de leitura)

Na VPS:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/mark-crm -N "" -C "vps-crm-ephata"
cat ~/.ssh/mark-crm.pub
printf 'Host github.com\n  IdentityFile ~/.ssh/mark-crm\n  IdentitiesOnly yes\n' >> ~/.ssh/config
```

No GitHub: **Mark-CRM → Settings → Deploy keys → Add deploy key**, colar a chave pública e **não** marcar "Allow write access".

### Instalar

```sh
git clone git@github.com:flaviosvalle/Mark-CRM.git /opt/mark-crm
cd /opt/mark-crm
git checkout v1.108.100
REPO_URL=git@github.com:flaviosvalle/Mark-CRM.git \
  bash hostgator-setup-kit/install-single-server.sh --domain crm.ephata.pt
```

O `REPO_URL` em SSH é o que permite ao kit ler as etiquetas de versão do repositório privado. A conta de administração e as palavras-passe geradas ficam em `.runtime/admin-credentials`. Guarde-as fora da VPS e apague o ficheiro depois.

### Confirmar que corre o código do fork

```sh
grep -E '^(APP|WORKER|SCHEDULER)_IMAGE=' .env
# esperado: ghcr.io/flaviosvalle/...:1.108.100 nas três
docker compose -f docker-compose.prod.yml ps
curl -s https://crm.ephata.pt/api/v1/health
```

Se aparecer `ghcr.io/melgarafael` no `.env`, **pare**: está a correr o original, sem o patch.

### Depois de instalar (no CRM, com a conta de administração)

1.  **País da organização:** Definições → Organização → País = **Portugal**. Define a régua do telefone (`+351`), do NIF e os textos do RGPD.
2.  **Módulo de empresas e pessoas:** `/admin/sistema` → ligar **crm_b2b**. Sem ele, as rotas de empresas, pessoas e vínculos respondem 404.
3.  **Token do `crm-sync`** (o site ephata.pt usa-o para enviar o cadastro): Definições → Tokens de API → novo token com **exatamente** estes escopos:
    *   `crm:write` (criar e editar cadastro, bloquear contactos);
    *   `mcp:read` (ler contactos bloqueados na reconciliação);
    *   `role:manager` (criar empresas, pessoas e vínculos exige papel de gerente).

    **Não** marcar `mcp:write` nem `messages:write`: o token fica no servidor do site e não deve conseguir enviar mensagens. O token aparece só uma vez; guarde-o no `.env` do site (`CRM_API_TOKEN`).

## Atualizar

O repositório é privado, por isso a procura automática de versões do kit não encontra nada e a VPS não se atualiza sozinha. Para atualizar, indique a versão:

```sh
cd /opt/mark-crm
git fetch --tags origin
bash hostgator-setup-kit/update.sh --to v1.108.101
```

O `update.sh` faz backup antes de mudar e aplica o `supabase/baseline.sql` (é por isso que as migrações do fork também estão no baseline). Para voltar atrás, use a versão anterior no `--to`.

## Trazer novidades do original

```sh
git remote add upstream https://github.com/melgarafael/DeskcommCRM.git   # uma vez
git fetch upstream
git merge upstream/main   # ou a etiqueta de uma versão do original
```

Pontos a rever em cada merge:

*   **Número da migração do fork** (`9348_identificador_fiscal_da_empresa`): se o original usar o mesmo número, renomeie a do fork para o próximo livre (a migração e o rótulo no `baseline.sql`).
*   **Namespace das imagens:** `IMG_NS`, `docker-compose.prod.yml`, `.env.hostgator.example`, `REPO_URL` em `install.sh` e `comecar.sh`, os labels dos Dockerfiles e `tests/unit/_identidade-deste-repo.ts` têm de continuar a apontar para `flaviosvalle` / `Mark-CRM`. O teste `tests/unit/namespace-das-imagens.test.ts` falha se não for assim.
*   Correr `pnpm test:unit`, `pnpm cercas` e `pnpm test:db` (este precisa de Docker) antes de criar a etiqueta.

## Pendente

*   **Backup do CRM (B6):** `pg_dump` noturno e Storage, cifrados com `age`, por SFTP para o servidor de backup local. O kit já tem `hostgator-setup-kit/backup.sh` (cópia na própria VPS). O envio para o servidor local ainda não está feito. Até lá, a Fase P (dados reais) não deve começar.
*   **`pnpm test:db`** ainda não correu sobre o patch (sem Docker no computador onde foi feito). Tem de correr antes da Fase P, porque a migração 9348 mexe no esquema.
