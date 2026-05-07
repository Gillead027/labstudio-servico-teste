# LabStudio Servico Teste

Projeto separado para testes e continuacao da implementacao do servico LabStudio CRJ.

Este repositorio foi criado para nao misturar os experimentos com o repositorio principal `labstudio-sistema`.

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

Valores seguros de exemplo para producao:

```env
PORT=3001
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_ANON_KEY=sua_chave_publica_anon_do_supabase
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key_apenas_no_servidor
BOT_NOTIFY_NUMBER=5527999999999
PUBLIC_SITE_URL=https://labstudio-exemplo.vercel.app
PUBLIC_BOT_URL=https://bot.labstudio-exemplo.com
ALLOWED_ORIGINS=https://labstudio-exemplo.vercel.app,https://www.labstudio-exemplo.com
QR_PAGE_TOKEN=troque-por-um-token-forte-do-qr
INTERNAL_API_TOKEN=troque-por-um-token-interno-forte
PUPPETEER_EXECUTABLE_PATH=
WWEBJS_AUTH_PATH=.wwebjs_auth
LABSTUDIO_CONFIG_ENV=producao
```

Nunca coloque a `SUPABASE_SERVICE_ROLE_KEY` em arquivos HTML. Ela deve ficar somente no `.env`, usada pelo `server.js`.

`INTERNAL_API_TOKEN` protege chamadas manuais/internas para rotas sensiveis do bot. O fluxo normal de agendamento nao expoe esse token no navegador: o proprio backend salva o agendamento e tenta enviar a notificacao.

`PUBLIC_BOT_URL` deve apontar para o backend persistente do bot/API com HTTPS. Em localhost, pode ficar vazio para o servidor usar a propria URL da requisicao.

`LABSTUDIO_CONFIG_ENV` define qual linha da tabela `labstudio_configuracoes` sera lida pelo backend. No desenvolvimento local da v2, use `v2-local`. Se a leitura da configuracao no Supabase falhar ou se nao existir uma linha ativa para esse ambiente, o sistema continua usando o fallback local.

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

Na primeira execucao, abra a pagina protegida informada no terminal. Ela mostra QR Code e tambem permite gerar codigo de pareamento pelo numero do WhatsApp do CRJ.

Exemplo:

```text
http://localhost:3001/qr?token=SEU_TOKEN
```

Para entrar com codigo, informe o WhatsApp com DDD na propria pagina. No celular, abra WhatsApp, va em `Aparelhos conectados`, escolha `Conectar aparelho` e use a opcao de conectar com numero de telefone.

A sessao local fica em `.wwebjs_auth/` e o cache em `.wwebjs_cache/`.

## Publicacao

Use a Vercel para servir `index.html`, `cadastro.html` e `admin.html`. O backend com `server.js`, Supabase service role e bot WhatsApp deve rodar em VPS/servidor persistente, porque `whatsapp-web.js` precisa manter processo, Chrome e pasta `.wwebjs_auth/`.

Antes de publicar em producao:

- troque `https://SEU-DOMINIO-DO-BACKEND.com` no `vercel.json` pelo dominio real HTTPS do backend/API;
- configure `PUBLIC_SITE_URL` com o dominio publico da Vercel;
- configure `PUBLIC_BOT_URL` com o dominio HTTPS do backend persistente;
- coloque todos os dominios publicos em `ALLOWED_ORIGINS`, separados por virgula;
- mantenha `SUPABASE_SERVICE_ROLE_KEY`, `QR_PAGE_TOKEN` e `INTERNAL_API_TOKEN` somente no backend/VPS;
- nunca use IP direto em HTTP para rotas de API em producao.

O arquivo `.env` real ja esta protegido pelo `.gitignore`; revise com `git status --short` antes de commitar para confirmar que ele nao aparece.

## Git

Este repositorio e independente do `labstudio-sistema`.

Antes de publicar qualquer alteracao, confira:

```bash
git status --short
```

## Arquivos Sensiveis

Nao versionar:

- `.env`
- `node_modules/`
- `.wwebjs_auth/`
- `.wwebjs_cache/`
- `tokens/`
- chaves, sessoes ou credenciais reais
