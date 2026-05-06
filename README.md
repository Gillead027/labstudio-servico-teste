# LabStudio CRJ - Ambiente Local De Testes

Esta pasta e exclusiva para testes locais e possiveis updates do sistema.

Regra deste ambiente: nao fazer commit, nao fazer push e nao preparar deploy. O sistema deve rodar em localhost.

## O Que Existe No Projeto

- site publico de agendamento;
- cadastro online para jovens;
- painel administrativo;
- bot WhatsApp com `whatsapp-web.js`;
- integracao com Supabase.

## Instalar Dependencias

```bash
npm install
```

## Configurar O `.env`

Use `.env.example` como base e preencha o arquivo `.env` local.

```powershell
Copy-Item .env.example .env
```

Valores esperados para localhost:

```env
PORT=3001
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_ANON_KEY=sua_chave_publica_anon_do_supabase
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key_apenas_no_servidor
BOT_NOTIFY_NUMBER=5527999999999
PUBLIC_SITE_URL=http://localhost:3001
ALLOWED_ORIGINS=http://localhost:3001,http://127.0.0.1:3001
QR_PAGE_TOKEN=troque-por-uma-senha-local
PUPPETEER_EXECUTABLE_PATH=
WWEBJS_AUTH_PATH=.wwebjs_auth
```

Nunca coloque a `SUPABASE_SERVICE_ROLE_KEY` em arquivos HTML. Ela deve ficar somente no `.env`, usada pelo `server.js`.

## Rodar Localmente

```bash
npm start
```

ou:

```bash
npm run dev
```

URLs locais:

- `http://localhost:3001/`
- `http://localhost:3001/admin.html`
- `http://localhost:3001/cadastro.html`
- `http://localhost:3001/health`
- `http://localhost:3001/status`

## WhatsApp

Na primeira execucao, abra a pagina do QR informada no terminal.

Exemplo:

```text
http://localhost:3001/qr?token=SEU_TOKEN
```

A sessao local fica em `.wwebjs_auth/` e o cache em `.wwebjs_cache/`.

## Banco De Dados

O banco principal continua sendo Supabase. Para testes 100% locais, as melhores alternativas sao:

1. Supabase local via Supabase CLI e Docker, mantendo a mesma ideia de Postgres/Auth/REST.
2. SQLite local, mais simples para testes offline, mas exigiria adaptar as consultas do `server.js`.

Como o sistema ja depende de Supabase Auth no painel e de tabelas no Supabase, a alternativa mais fiel e rodar Supabase local. SQLite so vale se a prioridade for simplicidade e se voce aceitar trocar parte da camada de dados.

## Git

Neste ambiente local de testes:

- nao fazer commit;
- nao fazer push;
- nao adicionar credenciais ao Git;
- conferir `git status --short` apenas para revisar alteracoes locais.

## Arquivos Sensíveis

Nao versionar:

- `.env`
- `node_modules/`
- `.wwebjs_auth/`
- `.wwebjs_cache/`
- `tokens/`
- chaves, sessoes ou credenciais reais
