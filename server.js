// ===============================
// IMPORTAÇÕES PRINCIPAIS
// ===============================
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");

// ===============================
// CONFIGURAÇÕES VIA VARIÁVEIS DE AMBIENTE
// Nunca coloque chaves, tokens ou números sensíveis direto no código.
// ===============================
const PORT = Number(process.env.PORT || 3001);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_NOTIFY_NUMBER = process.env.BOT_NOTIFY_NUMBER;
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";
const PUBLIC_SITE_URL = String(process.env.PUBLIC_SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const LABSTUDIO_CONFIG_ENV = process.env.LABSTUDIO_CONFIG_ENV || "v2-local";

// URL base do bot. Em testes locais, deixe vazio para usar localhost.
// Em producao, use HTTPS do backend persistente para QR/status e links do bot.
// Exemplo: PUBLIC_BOT_URL=https://bot.labstudio-exemplo.com
const PUBLIC_BOT_URL = String(process.env.PUBLIC_BOT_URL || "").replace(/\/$/, "");

// Token para proteger a página do QR Code.
// Defina no .env local:
// QR_PAGE_TOKEN=uma_senha_forte
const QR_PAGE_TOKEN = process.env.QR_PAGE_TOKEN;
const CHROME_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const WWEBJS_AUTH_PATH = process.env.WWEBJS_AUTH_PATH || ".wwebjs_auth";
// Compatibilidade com o repo que ja funciona: permite manter o mesmo nome de sessao do LocalAuth sem editar codigo.
const WHATSAPP_CLIENT_ID = process.env.WHATSAPP_CLIENT_ID || "labstudio-servico-teste";
const EXECUTION_ENV = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.FUNCTIONS_WORKER_RUNTIME || "";
const BOT_GUARD_RAILS = diagnosticarAmbienteBot();

const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origem) => origem.trim().replace(/\/$/, ""))
  .filter(Boolean);

const ORIGENS_PADRAO_DESENVOLVIMENTO = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`
];

const origensPermitidas = new Set([
  ...ORIGENS_PADRAO_DESENVOLVIMENTO,
  ...ALLOWED_ORIGINS,
  ...(PUBLIC_SITE_URL ? [PUBLIC_SITE_URL] : []),
  ...(PUBLIC_BOT_URL ? [PUBLIC_BOT_URL] : [])
]);

function exigirVariavelAmbiente(nome, valor) {
  if (!valor) {
    console.error(`❌ Variável de ambiente obrigatória ausente: ${nome}`);
    process.exit(1);
  }
}

function diagnosticarAmbienteBot() {
  // Guard rail de deploy: identifica sinais comuns de serverless, que nao mantem sessao persistente do WhatsApp.
  const ambienteServerless = Boolean(EXECUTION_ENV);

  // Guard rail de deploy: LocalAuth precisa de caminho gravavel e persistente para nao perder login/QR.
  const authPathTemporario = /^\/tmp(\/|$)/.test(String(WWEBJS_AUTH_PATH || ""));

  return {
    ambienteServerless,
    sinalServerless: EXECUTION_ENV || "",
    authPathTemporario,
    temChromeConfigurado: Boolean(CHROME_EXECUTABLE_PATH),
    authPath: WWEBJS_AUTH_PATH,
    clientId: WHATSAPP_CLIENT_ID
  };
}

function registrarDiagnosticoBot() {
  // Guard rail de deploy: centraliza logs do ambiente para facilitar suporte sem mudar o fluxo do bot.
  const tipoAmbiente = BOT_GUARD_RAILS.ambienteServerless
    ? `serverless detectado (${BOT_GUARD_RAILS.sinalServerless})`
    : "processo persistente/local";
  const chromeUsado = CHROME_EXECUTABLE_PATH || "padrao do whatsapp-web.js/Puppeteer";

  console.log("🧭 Diagnóstico do bot WhatsApp:");
  console.log(`   Ambiente: ${tipoAmbiente}`);
  console.log(`   LocalAuth: ${BOT_GUARD_RAILS.authPath}`);
  console.log(`   Client ID: ${BOT_GUARD_RAILS.clientId}`);
  console.log(`   Chrome/Puppeteer: ${chromeUsado}`);

  if (BOT_GUARD_RAILS.ambienteServerless) {
    console.warn("⚠️ Ambiente serverless detectado. O bot WhatsApp precisa de processo persistente e sessao gravavel para manter login/QR.");
  }

  if (BOT_GUARD_RAILS.authPathTemporario) {
    console.warn("⚠️ WWEBJS_AUTH_PATH aponta para /tmp. Em deploy, use um caminho persistente para nao perder a sessao do WhatsApp.");
  }

  if (!BOT_GUARD_RAILS.temChromeConfigurado) {
    console.warn("⚠️ PUPPETEER_EXECUTABLE_PATH nao configurado. Se o Chrome falhar no deploy, configure o caminho do Chrome/Chromium instalado.");
  }
}

exigirVariavelAmbiente("SUPABASE_URL", SUPABASE_URL);
exigirVariavelAmbiente("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
exigirVariavelAmbiente("BOT_NOTIFY_NUMBER", BOT_NOTIFY_NUMBER);

// Token usado apenas para chamadas internas/manuais a rotas sensíveis.
// Fluxos normais do site não expõem esse token no navegador.
if (!INTERNAL_API_TOKEN) {
  console.warn("⚠️ INTERNAL_API_TOKEN não configurado. Rotas internas de WhatsApp ficarão bloqueadas.");
}

// QR_PAGE_TOKEN não derruba o servidor, mas a rota /qr fica bloqueada se ele não existir.
if (!QR_PAGE_TOKEN) {
  console.warn("⚠️ QR_PAGE_TOKEN não configurado. A página /qr ficará bloqueada por segurança.");
}

// Variáveis recomendadas para produção: não bloqueiam o servidor, mas deixam claro o que precisa ser revisado no deploy.
if (!PUBLIC_SITE_URL || PUBLIC_SITE_URL.includes("localhost")) {
  console.warn("⚠️ PUBLIC_SITE_URL está vazio ou apontando para localhost. Em produção, configure a URL pública do site.");
}

if (!ALLOWED_ORIGINS.length) {
  console.warn("⚠️ ALLOWED_ORIGINS não configurado. Apenas localhost e URLs públicas configuradas serão aceitas no CORS.");
}

// Variavel recomendada para operacao: valida o formato do destino antes de o bot tentar enviar notificacoes.
if (!validarTelefoneBrasileiroComDdd(BOT_NOTIFY_NUMBER)) {
  console.warn("⚠️ BOT_NOTIFY_NUMBER parece fora do padrao brasileiro com DDD. As notificacoes podem falhar se o WhatsApp nao reconhecer o numero.");
}

// Variavel recomendada para deploy: evita confusao quando links publicos do bot forem usados fora do localhost.
if (PUBLIC_BOT_URL && PUBLIC_BOT_URL.includes("localhost")) {
  console.warn("⚠️ PUBLIC_BOT_URL aponta para localhost. Em producao, configure a URL publica do servidor do bot se ela for diferente do site.");
}

// ===============================
// CONFIGURAÇÃO DO SERVIDOR EXPRESS
// Esse servidor recebe requisições do site
// Exemplo: POST /notificar
// ===============================
const app = express();
app.set("trust proxy", 1);
// Não revela a tecnologia do servidor no cabeçalho X-Powered-By.
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

const rateLimitMemoria = new Map();

// O site chega pela Vercel: req.ip é o IP da Vercel (igual para todos os visitantes).
// O IP real do visitante vem no cabeçalho que a Vercel adiciona.
function obterIpVisitante(req) {
  const ipVercel = String(req.headers["x-vercel-forwarded-for"] || "").split(",")[0].trim();
  return ipVercel || req.ip || req.socket.remoteAddress || "origem-desconhecida";
}

function contarRequisicao(chave, janelaMs) {
  const agora = Date.now();
  const registro = rateLimitMemoria.get(chave) || { inicio: agora, total: 0 };

  if (agora - registro.inicio > janelaMs) {
    registro.inicio = agora;
    registro.total = 0;
  }

  registro.total += 1;
  rateLimitMemoria.set(chave, registro);
  return registro.total;
}

function limitarRequisicoes({ janelaMs, maximo, nome }) {
  return (req, res, next) => {
    // Limite por visitante e, como o cabeçalho pode ser forjado em acesso direto,
    // um teto geral por conexão (10x maior) que segura abuso mesmo assim.
    const totalVisitante = contarRequisicao(`${nome}:visitante:${obterIpVisitante(req)}`, janelaMs);
    const totalConexao = contarRequisicao(`${nome}:conexao:${req.ip || "origem-desconhecida"}`, janelaMs);

    if (totalVisitante > maximo || totalConexao > maximo * 10) {
      return responderErroApi(res, 429, "Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.");
    }

    return next();
  };
}

// Compara segredos em tempo constante para não vazar o token por medição de tempo de resposta.
function segredoConfere(recebido, esperado) {
  const a = Buffer.from(String(recebido || ""));
  const b = Buffer.from(String(esperado || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

setInterval(() => {
  const agora = Date.now();
  const tempoMaximo = 60 * 60 * 1000;

  for (const [chave, registro] of rateLimitMemoria.entries()) {
    if (agora - registro.inicio > tempoMaximo) {
      rateLimitMemoria.delete(chave);
    }
  }
}, 15 * 60 * 1000).unref();

// ===============================
// LIMITES DE ROTAS PÚBLICAS
// Reaproveitam o limitador em memória para reduzir abuso sem dependência externa.
// ===============================
const limitarConsultasPublicas = limitarRequisicoes({
  janelaMs: 5 * 60 * 1000,
  maximo: 120,
  nome: "consultas-publicas"
});

const limitarConfiguracoesPublicas = limitarRequisicoes({
  janelaMs: 5 * 60 * 1000,
  maximo: 60,
  nome: "configuracoes-publicas"
});

const limitarQrPublico = limitarRequisicoes({
  janelaMs: 5 * 60 * 1000,
  maximo: 40,
  nome: "qr-publico"
});

const limitarPareamento = limitarRequisicoes({
  janelaMs: 10 * 60 * 1000,
  maximo: 8,
  nome: "pareamento-whatsapp"
});

// ===============================
// CONFIGURAÇÃO DE CORS
// Permite localhost no desenvolvimento e as origens definidas no .env.
// Requisições sem Origin, como curl ou chamadas locais diretas, continuam liberadas.
// ===============================
app.use(cors({
  origin(origin, callback) {
    const origemNormalizada = origin ? String(origin).replace(/\/$/, "") : "";

    if (!origin || origensPermitidas.has(origemNormalizada)) {
      return callback(null, true);
    }

    console.warn(`⚠️ Origem bloqueada pelo CORS: ${origin}`);
    return callback(null, false);
  }
}));

app.use(express.json({ limit: "20kb" }));

// ===============================
// ERROS DE PAYLOAD JSON
// Padroniza respostas quando o navegador envia JSON quebrado ou grande demais.
// ===============================
app.use((err, req, res, next) => {
  // Payload inválido: evita expor stack trace ou detalhes técnicos do parser para o usuário.
  if (err && err.type === "entity.parse.failed") {
    return responderPayloadInvalido(res, "Não foi possível ler os dados enviados. Atualize a página e tente novamente.");
  }

  // Payload grande demais: mantém a API estável antes de chegar nas regras das rotas.
  if (err && err.type === "entity.too.large") {
    return responderPayloadInvalido(res, "Os dados enviados são muito grandes para esta solicitação.", 413);
  }

  return next(err);
});

// ===============================
// SERVIR APENAS ARQUIVOS PÚBLICOS NECESSÁRIOS
// Evita expor arquivos internos da raiz, como server.js, package.json ou .env.example.
// ===============================
const arquivosPublicosPermitidos = new Map([
  ["/index.html", "index.html"],
  ["/admin.html", "admin.html"],
  ["/cadastro.html", "cadastro.html"]
]);

app.use((req, res, next) => {
  // Arquivos estáticos seguros: só libera páginas públicas conhecidas e mantém assets externos via CDN.
  if (!["GET", "HEAD"].includes(req.method)) {
    return next();
  }

  const arquivoPermitido = arquivosPublicosPermitidos.get(req.path);

  if (!arquivoPermitido) {
    return next();
  }

  return res.sendFile(path.join(__dirname, arquivoPermitido));
});

// Página pública de agendamento
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Painel administrativo
app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// Página pública de cadastro online
app.get("/cadastro.html", (req, res) => {
  res.sendFile(path.join(__dirname, "cadastro.html"));
});

// Rota simples para testar se o servidor está online
app.get("/health", (req, res) => {
  res.send("🔥 BOT ONLINE");
});

// ===============================
// CONEXÃO COM SUPABASE
// Operações internas do servidor usam a service role.
// Nunca exponha SUPABASE_SERVICE_ROLE_KEY em arquivos HTML ou no navegador.
// ===============================
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

// ===============================
// REGRAS PÚBLICAS DE AGENDAMENTO
// Mantidas também no servidor para preparar o RLS sem depender do frontend.
// ===============================
const HORARIOS_TERCA_QUINTA = ["18:00", "18:30"];

const DATAS_BLOQUEADAS = [
  "2024-07-19",
  "2024-05-01",
  "2024-05-30"
];

// ===============================
// CONFIGURAÇÃO CENTRAL DO LABSTUDIO
// Nesta etapa v2.0, a configuração é somente fallback local.
// Futuramente, obterConfiguracaoLabStudio poderá ler do Supabase sem mudar
// a lógica atual de agendamento da v1.0.
// ===============================
const DEFAULT_LABSTUDIO_CONFIG = {
  dias_funcionamento: [2, 4],
  dias_funcionamento_label: ["terça-feira", "quinta-feira"],
  horarios_disponiveis: [...HORARIOS_TERCA_QUINTA],
  datas_bloqueadas: [...DATAS_BLOQUEADAS],
  idade_minima: 15,
  idade_maxima: 29,
  limite_faltas_bloqueio: 2,
  link_publico: PUBLIC_SITE_URL,
  mensagem_funcionamento: "O LabStudio funciona às terças e quintas-feiras, mediante disponibilidade de horário.",
  versao_config: "v2-local-fallback"
};

async function obterConfiguracaoLabStudio() {
  const ambiente = LABSTUDIO_CONFIG_ENV;

  try {
    // Leitura segura: busca a configuração ativa do ambiente local da v2.
    // Não cria, altera nem remove dados no Supabase.
    const { data, error } = await supabase
      .from("labstudio_configuracoes")
      .select("*")
      .eq("ambiente", ambiente)
      .eq("ativo", true)
      .maybeSingle();

    if (error) {
      console.warn(
        `⚠️ Falha ao consultar labstudio_configuracoes para ambiente "${ambiente}". Usando fallback local: ${error.message}`
      );

      return {
        origem: "fallback-local",
        ambiente,
        config: DEFAULT_LABSTUDIO_CONFIG
      };
    }

    if (!data) {
      console.warn(
        `⚠️ Nenhuma configuração ativa encontrada para ambiente "${ambiente}". Usando fallback local.`
      );

      return {
        origem: "fallback-local",
        ambiente,
        config: DEFAULT_LABSTUDIO_CONFIG
      };
    }

    const configBanco = data.config && typeof data.config === "object"
      ? { ...data, ...data.config }
      : data;

    return {
      origem: "supabase",
      ambiente,
      config: normalizarConfiguracaoLabStudio(configBanco)
    };
  } catch (err) {
    console.warn(
      `⚠️ Erro inesperado ao obter configuração do LabStudio para ambiente "${ambiente}". Usando fallback local:`,
      err
    );

    return {
      origem: "fallback-local",
      ambiente,
      erro: err,
      config: DEFAULT_LABSTUDIO_CONFIG
    };
  }
}

function normalizarConfiguracaoLabStudio(config) {
  const configRecebida = config && typeof config === "object" ? config : {};

  return {
    ...DEFAULT_LABSTUDIO_CONFIG,
    ...configRecebida,
    dias_funcionamento: Array.isArray(configRecebida.dias_funcionamento) && configRecebida.dias_funcionamento.length > 0
      ? configRecebida.dias_funcionamento
      : DEFAULT_LABSTUDIO_CONFIG.dias_funcionamento,
    dias_funcionamento_label: Array.isArray(configRecebida.dias_funcionamento_label) && configRecebida.dias_funcionamento_label.length > 0
      ? configRecebida.dias_funcionamento_label
      : DEFAULT_LABSTUDIO_CONFIG.dias_funcionamento_label,
    horarios_disponiveis: Array.isArray(configRecebida.horarios_disponiveis) && configRecebida.horarios_disponiveis.length > 0
      ? configRecebida.horarios_disponiveis
      : DEFAULT_LABSTUDIO_CONFIG.horarios_disponiveis,
    datas_bloqueadas: Array.isArray(configRecebida.datas_bloqueadas)
      ? configRecebida.datas_bloqueadas
      : DEFAULT_LABSTUDIO_CONFIG.datas_bloqueadas,
    idade_minima: Number.isFinite(Number(configRecebida.idade_minima))
      ? Number(configRecebida.idade_minima)
      : DEFAULT_LABSTUDIO_CONFIG.idade_minima,
    idade_maxima: Number.isFinite(Number(configRecebida.idade_maxima))
      ? Number(configRecebida.idade_maxima)
      : DEFAULT_LABSTUDIO_CONFIG.idade_maxima,
    limite_faltas_bloqueio: Number.isFinite(Number(configRecebida.limite_faltas_bloqueio))
      ? Number(configRecebida.limite_faltas_bloqueio)
      : DEFAULT_LABSTUDIO_CONFIG.limite_faltas_bloqueio,
    link_publico: configRecebida.link_publico || DEFAULT_LABSTUDIO_CONFIG.link_publico,
    mensagem_funcionamento: configRecebida.mensagem_funcionamento || DEFAULT_LABSTUDIO_CONFIG.mensagem_funcionamento,
    versao_config: configRecebida.versao_config || DEFAULT_LABSTUDIO_CONFIG.versao_config
  };
}

async function obterConfigLabStudioSegura() {
  try {
    const resultado = await obterConfiguracaoLabStudio();
    return normalizarConfiguracaoLabStudio(resultado.config);
  } catch (err) {
    console.error("❌ Falha ao carregar configuração. Usando fallback local:", err);
    return DEFAULT_LABSTUDIO_CONFIG;
  }
}

function mensagemFaixaEtaria(config = DEFAULT_LABSTUDIO_CONFIG) {
  return `O LabStudio atende jovens de ${config.idade_minima} a ${config.idade_maxima} anos.`;
}

function mensagemFaixaEtariaCrj(config = DEFAULT_LABSTUDIO_CONFIG) {
  return `O CRJ atende jovens de ${config.idade_minima} a ${config.idade_maxima} anos.`;
}

// ===============================
// CONFIGURAÇÃO DO CLIENTE WHATSAPP
// LocalAuth salva a sessão do WhatsApp.
// Em localhost, a sessão fica em .wwebjs_auth por padrão.
// Guard rail de deploy: os diagnosticos avisam quando o ambiente pode nao manter esta sessao.
// ===============================
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: WHATSAPP_CLIENT_ID,
    dataPath: WWEBJS_AUTH_PATH
  }),
  puppeteer: {
    ...(CHROME_EXECUTABLE_PATH ? { executablePath: CHROME_EXECUTABLE_PATH } : {}),
    headless: true,
    timeout: 0,
    protocolTimeout: 120000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-extensions",
      "--disable-popup-blocking"
    ]
  }
});

// ===============================
// STATUS DO BOT
// Usamos isso para saber se o WhatsApp já está pronto.
// ===============================
let botPronto = false;
// Momento da última conexão; a divulgação espera o WhatsApp Web estabilizar depois disso.
let botProntoDesde = null;

// ===============================
// CONTROLE DO QR CODE
// Em vez de imprimir o QR no terminal, salvamos o QR atual em memória
// e servimos como imagem via rota /qr.png.
// ===============================
let qrAtualTexto = null;
let qrAtualDataUrl = null;
let qrGeradoEm = null;
let codigoPareamentoAtual = null;
let codigoPareamentoGeradoEm = null;
const mensagensWhatsAppProcessadas = new Map();

function obterIdMensagemWhatsApp(msg) {
  // Estabilidade do bot: usa o id nativo quando existir para evitar responder duas vezes ao mesmo WhatsApp.
  return msg && msg.id && msg.id._serialized
    ? msg.id._serialized
    : `${msg && msg.from ? msg.from : "sem-origem"}:${msg && msg.timestamp ? msg.timestamp : Date.now()}:${msg && msg.body ? msg.body : ""}`;
}

function mensagemWhatsAppJaProcessada(msg) {
  // Estabilidade do bot: message e message_create podem chegar para a mesma mensagem; este controle evita duplicidade.
  const idMensagem = obterIdMensagemWhatsApp(msg);

  if (mensagensWhatsAppProcessadas.has(idMensagem)) {
    return true;
  }

  mensagensWhatsAppProcessadas.set(idMensagem, Date.now());
  return false;
}

setInterval(() => {
  const agora = Date.now();
  const tempoMaximo = 10 * 60 * 1000;

  for (const [idMensagem, horario] of mensagensWhatsAppProcessadas.entries()) {
    if (agora - horario > tempoMaximo) {
      mensagensWhatsAppProcessadas.delete(idMensagem);
    }
  }
}, 5 * 60 * 1000).unref();

// ===============================
// FUNÇÃO: OBTER URL BASE DO BOT
// Em localhost, usa a URL local por padrão.
// ===============================
function obterUrlBaseBot(req = null) {
  if (PUBLIC_BOT_URL) return PUBLIC_BOT_URL;

  if (req) {
    const protocolo = req.protocol || "http";
    const host = req.headers.host;
    return `${protocolo}://${host}`;
  }

  return `http://localhost:${PORT}`;
}

// ===============================
// FUNÇÃO: VERIFICAR TOKEN DA PÁGINA DO QR
// Protege o QR Code para ninguém aleatório logar seu WhatsApp.
// ===============================
function verificarTokenQr(req, res) {
  if (!QR_PAGE_TOKEN) {
    res.status(500).send(`
      <html>
        <head>
          <meta charset="UTF-8" />
          <title>QR Code bloqueado</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 32px;">
          <h2>QR Code bloqueado</h2>
          <p>A variável <strong>QR_PAGE_TOKEN</strong> não está configurada no servidor.</p>
          <p>Crie essa variável no arquivo <strong>.env</strong> local para liberar a página com segurança.</p>
        </body>
      </html>
    `);

    return false;
  }

  const tokenRecebido = String(req.query.token || "");

  if (!segredoConfere(tokenRecebido, QR_PAGE_TOKEN)) {
    res.status(403).send(paginaAvisoBot("Acesso negado", "Link inválido ou incompleto. Use o link da página de conexão com o token."));

    return false;
  }

  return true;
}

// ===============================
// ROTA: PÁGINA DO QR CODE
// Acesse assim:
// http://localhost:3001/qr?token=SEU_TOKEN
// ===============================
// Segurança de rota sensível: limita tentativas de abrir a página do QR mesmo com token.
function escaparAtributoHtml(valor) {
  // Segurança da tela protegida: evita quebrar atributos HTML quando o token forte tiver simbolos.
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ===============================
// VISUAL DAS PÁGINAS DO BOT (QR, PAREAMENTO E AVISOS)
// Mesmo estilo do site: papel + tinta, tipografia de pôster, cores chapadas.
// ===============================
const ESTILO_PAGINAS_BOT = `
  :root {
    --papel: #F6F4EF; --branco: #FFFFFF; --tinta: #1C1B19; --tinta-2: #57534E;
    --amarelo: #FFD948; --roxo: #B9A4FF; --verde: #B6E36B; --rec: #FF3B2F;
    --borda: 1.5px solid var(--tinta); --sombra-dura: 6px 6px 0 var(--tinta);
    --quart: cubic-bezier(0.25, 1, 0.5, 1); --expo: cubic-bezier(0.16, 1, 0.3, 1);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
    background: var(--papel); color: var(--tinta);
    font-family: "Schibsted Grotesk", system-ui, sans-serif; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .cartao {
    width: min(760px, 100%); background: var(--branco); border: var(--borda);
    border-radius: 16px; box-shadow: var(--sombra-dura); padding: 28px;
  }
  .topo { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; }
  .status { white-space: nowrap; }
  .marca { display: flex; align-items: baseline; gap: 8px; }
  .marca strong { font-family: "Big Shoulders Display", sans-serif; font-weight: 900; font-size: 1.6rem; text-transform: uppercase; line-height: 1; }
  .marca span { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--tinta-2); }
  .status {
    display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border: var(--borda);
    border-radius: 999px; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  }
  .status::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: #A8A29E; }
  .status[data-status="conectado"]::before { background: #2F9E44; }
  .status[data-status="aguardando_qr"]::before { background: var(--rec); animation: pulsar 1.6s var(--quart) infinite; }
  @keyframes pulsar { 0% { box-shadow: 0 0 0 0 rgba(255,59,47,.55); } 70% { box-shadow: 0 0 0 9px rgba(255,59,47,0); } 100% { box-shadow: 0 0 0 0 rgba(255,59,47,0); } }
  h1 {
    margin: 0 0 8px; font-family: "Big Shoulders Display", sans-serif; font-weight: 900;
    font-size: clamp(2.8rem, 8vw, 4.4rem); line-height: 0.9; text-transform: uppercase;
  }
  h2 { margin: 0 0 6px; font-size: 1.05rem; }
  p { margin: 0 0 12px; }
  .lead { color: var(--tinta-2); margin-bottom: 22px; }
  .pequeno { font-size: 0.85rem; color: var(--tinta-2); }
  .grade { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
  .bloco { border: var(--borda); border-radius: 14px; padding: 20px; }
  .bloco-qr { background: var(--papel); text-align: center; }
  .bloco-codigo { background: var(--roxo); }
  .qr-moldura { display: inline-block; padding: 12px; background: var(--branco); border: var(--borda); border-radius: 12px; margin-bottom: 10px; }
  .qr-moldura img { display: block; width: min(260px, 100%); height: auto; transition: opacity 0.3s ease; }
  .qr-moldura img.trocando { opacity: 0.25; }
  label { display: block; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; margin: 12px 0 4px; }
  input {
    width: 100%; padding: 8px 0 10px; border: 0; border-bottom: var(--borda); border-radius: 0;
    background: transparent; color: var(--tinta); font: 500 1.1rem "Schibsted Grotesk", system-ui, sans-serif; outline: none;
  }
  input:focus { border-bottom: 3px solid var(--tinta); }
  .botao {
    display: inline-flex; align-items: center; justify-content: center; gap: 10px; width: 100%; margin-top: 16px;
    padding: 14px 18px; border: var(--borda); border-radius: 999px; background: var(--tinta); color: var(--papel);
    font: 700 0.98rem "Schibsted Grotesk", system-ui, sans-serif; text-decoration: none; cursor: pointer;
    position: relative; overflow: hidden; isolation: isolate; transition: color 0.35s ease, transform 0.2s var(--quart);
  }
  .botao::before { content: ""; position: absolute; inset: 0; z-index: -1; background: var(--amarelo); transform: translateY(101%); transition: transform 0.5s var(--expo); }
  .botao:hover { color: var(--tinta); }
  .botao:hover::before { transform: none; }
  .botao:active { transform: scale(0.98); }
  .botao-secundario { background: var(--branco); color: var(--tinta); }
  .aviso { border: var(--borda); border-radius: 14px; padding: 20px; background: var(--amarelo); }
  .aviso.ok { background: var(--verde); }
  .codigo {
    margin: 8px 0 18px; padding: 18px; border: var(--borda); border-radius: 14px; background: var(--amarelo);
    font-family: "Big Shoulders Display", sans-serif; font-weight: 900; font-size: clamp(2.6rem, 10vw, 4.2rem);
    letter-spacing: 0.08em; text-align: center; line-height: 1;
  }
  ol { margin: 0 0 16px; padding: 0; list-style: none; border-top: var(--borda); }
  ol li { padding: 10px 0; border-bottom: var(--borda); }
  code { font-family: ui-monospace, monospace; background: var(--papel); padding: 2px 6px; border-radius: 6px; }
  @media (max-width: 640px) { .grade { grid-template-columns: 1fr; } .cartao { padding: 20px; box-shadow: 4px 4px 0 var(--tinta); } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

function paginaBotHtml({ titulo, corpo, script = "", status = "" }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  <title>${titulo} · LabStudio</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@900&family=Schibsted+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
  <style>${ESTILO_PAGINAS_BOT}</style>
</head>
<body>
  <main class="cartao">
    <div class="topo">
      <div class="marca"><strong>LabStudio</strong><span>Bot WhatsApp</span></div>
      ${status ? `<span class="status" id="statusBot" data-status="${status}">${status === "conectado" ? "Conectado" : status === "aguardando_qr" ? "Aguardando leitura" : "Iniciando"}</span>` : ""}
    </div>
    ${corpo}
  </main>
  ${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

function paginaAvisoBot(titulo, mensagem) {
  return paginaBotHtml({
    titulo,
    corpo: `<h1>${titulo}</h1><div class="aviso"><p>${mensagem}</p></div>`
  });
}

app.get("/qr", limitarQrPublico, (req, res) => {
  if (!verificarTokenQr(req, res)) return;

  const baseUrl = obterUrlBaseBot(req);
  const token = encodeURIComponent(QR_PAGE_TOKEN);
  const tokenFormulario = escaparAtributoHtml(QR_PAGE_TOKEN);
  const qrImagemUrl = `${baseUrl}/qr.png?token=${token}&t=${Date.now()}`;
  const status = botPronto ? "conectado" : qrAtualTexto ? "aguardando_qr" : "iniciando";
  const horaQr = qrGeradoEm ? new Date(qrGeradoEm).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "";

  let corpo;

  if (botPronto) {
    corpo = `
      <h1>Conectado.</h1>
      <div class="aviso ok">
        <h2>WhatsApp do CRJ conectado</h2>
        <p>O bot já está respondendo e enviando mensagens. Pode fechar esta página.</p>
      </div>`;
  } else {
    const blocoQr = qrAtualTexto
      ? `
        <div class="qr-moldura"><img id="qrImagem" src="${qrImagemUrl}" alt="QR Code para conectar o WhatsApp" /></div>
        <p class="pequeno" id="qrHora">Gerado às ${horaQr} · troca sozinho quando renovar</p>`
      : `
        <div class="aviso"><p><strong>Preparando o QR…</strong></p><p class="pequeno">O bot está iniciando. Esta página atualiza sozinha.</p></div>`;

    corpo = `
      <h1>Conectar WhatsApp</h1>
      <p class="lead">No celular do CRJ: WhatsApp Business → Aparelhos conectados → Conectar um aparelho.</p>
      <div class="grade">
        <section class="bloco bloco-qr">
          <h2>Escanear QR</h2>
          ${blocoQr}
        </section>
        <section class="bloco bloco-codigo">
          <h2>Ou entrar com código</h2>
          <p class="pequeno">Use se a câmera não ler o QR. No WhatsApp, escolha "Conectar com número de telefone".</p>
          <form method="GET" action="/pairing-code">
            <input type="hidden" name="token" value="${tokenFormulario}" />
            <label for="phone">WhatsApp do bot (com DDD)</label>
            <input id="phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="Ex: 27999999999" required />
            <button class="botao" type="submit">Gerar código</button>
          </form>
        </section>
      </div>`;
  }

  // Acompanha o /status: troca o QR quando ele renova e recarrega ao conectar.
  const script = `
    (function () {
      var statusInicial = ${JSON.stringify(status)};
      var qrInicial = ${JSON.stringify(qrGeradoEm || "")};
      var imagemBase = ${JSON.stringify(`${baseUrl}/qr.png?token=${token}`)};
      setInterval(function () {
        fetch("/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
          var agora = s.botPronto ? "conectado" : s.temQrDisponivel ? "aguardando_qr" : "iniciando";
          if (agora !== statusInicial) { location.reload(); return; }
          if (s.qrGeradoEm && s.qrGeradoEm !== qrInicial) {
            qrInicial = s.qrGeradoEm;
            var img = document.getElementById("qrImagem");
            if (img) {
              img.classList.add("trocando");
              img.onload = function () { img.classList.remove("trocando"); };
              img.src = imagemBase + "&t=" + Date.now();
            }
            var hora = document.getElementById("qrHora");
            if (hora) hora.textContent = "Renovado às " + new Date(s.qrGeradoEm).toLocaleTimeString("pt-BR") + " · troca sozinho quando renovar";
          }
        }).catch(function () {});
      }, 4000);
    })();`;

  res.send(paginaBotHtml({ titulo: "Conectar WhatsApp", corpo, script: botPronto ? "" : script, status }));
});

// ===============================
// ROTA: IMAGEM PNG DO QR CODE
// Essa rota retorna uma imagem real do QR Code.
// A página /qr usa essa imagem.
// ===============================
// Segurança de rota sensível: limita downloads repetidos do QR, que é uma credencial temporária.
app.get("/qr.png", limitarQrPublico, async (req, res) => {
  if (!verificarTokenQr(req, res)) return;

  if (!qrAtualTexto) {
    return res.status(404).send("Nenhum QR Code disponível no momento.");
  }

  try {
    const qrBuffer = await QRCode.toBuffer(qrAtualTexto, {
      type: "png",
      width: 420,
      margin: 2,
      errorCorrectionLevel: "M"
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.send(qrBuffer);
  } catch (err) {
    console.error("❌ Erro ao gerar imagem do QR Code:", err);
    res.status(500).send("Erro ao gerar imagem do QR Code.");
  }
});

// ===============================
// ROTA: CODIGO DE PAREAMENTO
// Alternativa ao QR Code para vincular o WhatsApp pelo telefone.
// Acesse assim:
// http://localhost:3001/pairing-code?token=SEU_TOKEN&phone=5527999999999
// ===============================
// Segurança de rota sensível: limita geração de código de pareamento para reduzir abuso.
app.get("/pairing-code", limitarPareamento, async (req, res) => {
  if (!verificarTokenQr(req, res)) return;

  const phone = req.query.phone;

  if (!phone) {
    return res.status(400).send(paginaAvisoBot("Telefone obrigatório", "Volte para a página de conexão e informe o WhatsApp do bot com DDD."));
  }

  const phoneNumber = normalizarTelefonePareamentoBrasil(phone);

  if (!phoneNumber) {
    return res.status(400).send(paginaAvisoBot("Telefone inválido", "Informe um WhatsApp brasileiro com DDD, por exemplo 27999999999. O 55 é adicionado sozinho."));
  }

  try {
    const code = await client.requestPairingCode(phoneNumber);

    codigoPareamentoAtual = code;
    codigoPareamentoGeradoEm = new Date().toISOString();

    // Não exibimos o código no terminal para evitar vazamento em logs de produção.
    console.log(`🔐 Código de pareamento gerado para ${mascararNumeroWhatsApp(phoneNumber)}.`);

    res.send(paginaBotHtml({
      titulo: "Código de pareamento",
      corpo: `
        <h1>Seu código</h1>
        <p class="lead">Digite este código no WhatsApp do celular do CRJ.</p>
        <div class="codigo">${code}</div>
        <ol>
          <li>01 · Abra o WhatsApp Business no celular do CRJ</li>
          <li>02 · Vá em <strong>Aparelhos conectados → Conectar um aparelho</strong></li>
          <li>03 · Toque em <strong>Conectar com número de telefone</strong> e digite o código</li>
        </ol>
        <p class="pequeno">Telefone: <code>${phoneNumber}</code> · gerado às ${new Date(codigoPareamentoGeradoEm).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" })}</p>
        <a class="botao botao-secundario" href="/qr?token=${encodeURIComponent(QR_PAGE_TOKEN)}">Voltar para a conexão</a>`
    }));
  } catch (err) {
    console.error("❌ Erro ao gerar código de pareamento:", err);
    res.status(500).send(paginaAvisoBot("Não deu certo", "Não consegui gerar o código agora. Volte e tente de novo em alguns segundos, ou use o QR."));
  }
});

// ===============================
// ROTA: CODIGO DE PAREAMENTO EM JSON
// ===============================
// Segurança de rota sensível: aplica o mesmo limite do pareamento em HTML na versão JSON.
app.get("/pairing-code.json", limitarPareamento, async (req, res) => {
  if (!verificarTokenQr(req, res)) return;

  const phone = req.query.phone;

  if (!phone) {
    return res.status(400).json({
      ok: false,
      erro: "Informe o parametro phone."
    });
  }

  const phoneNumber = normalizarTelefonePareamentoBrasil(phone);

  if (!phoneNumber) {
    return res.status(400).json({
      ok: false,
      erro: "Telefone invalido. Informe um WhatsApp brasileiro com DDD."
    });
  }

  try {
    const code = await client.requestPairingCode(phoneNumber);

    codigoPareamentoAtual = code;
    codigoPareamentoGeradoEm = new Date().toISOString();

    // Não exibimos o código no terminal para evitar vazamento em logs de produção.
    console.log(`🔐 Código de pareamento gerado para ${mascararNumeroWhatsApp(phoneNumber)}.`);

    res.json({
      ok: true,
      code,
      phone: phoneNumber,
      generatedAt: codigoPareamentoGeradoEm
    });
  } catch (err) {
    console.error("❌ Erro ao gerar código de pareamento:", err);
    res.status(500).json({
      ok: false,
      erro: "Erro ao gerar codigo de pareamento."
    });
  }
});

// ===============================
// ROTA: STATUS DO BOT
// Útil para testar no navegador.
// ===============================
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    botPronto,
    temQrDisponivel: Boolean(qrAtualTexto),
    qrGeradoEm,
    temCodigoPareamentoDisponivel: Boolean(codigoPareamentoAtual),
    codigoPareamentoGeradoEm,
    publicSiteUrl: PUBLIC_SITE_URL,
    publicBotUrl: PUBLIC_BOT_URL || null
  });
});

// ===============================
// ROTA: CONFIGURAÇÕES PÚBLICAS DO LABSTUDIO
// Leitura pública e segura para o painel e, futuramente, para as telas públicas.
// Consulta apenas a configuração ativa do ambiente e nunca escreve no Supabase.
// ===============================
// Segurança de rota pública: limita consultas repetidas sem impedir carregamento normal das telas.
app.get("/api/configuracoes-publicas", limitarConfiguracoesPublicas, async (req, res) => {
  const ambiente = LABSTUDIO_CONFIG_ENV;

  try {
    const resultado = await obterConfiguracaoLabStudio();

    if (resultado.erro) {
      return res.status(500).json({
        ok: false,
        origem: "fallback-local",
        ambiente,
        mensagem: "Usando configuração padrão local.",
        config: DEFAULT_LABSTUDIO_CONFIG
      });
    }

    return res.json({
      ok: true,
      origem: resultado.origem || "fallback-local",
      ambiente: resultado.ambiente || ambiente,
      config: resultado.config || DEFAULT_LABSTUDIO_CONFIG
    });
  } catch (err) {
    console.error("❌ Falha na rota /api/configuracoes-publicas:", err);

    return res.status(500).json({
      ok: false,
      origem: "fallback-local",
      ambiente,
      mensagem: "Usando configuração padrão local.",
      config: DEFAULT_LABSTUDIO_CONFIG
    });
  }
});

// ===============================
// QR CODE PARA LOGIN NO WHATSAPP
// Agora NÃO imprimimos mais o QR no terminal.
// Geramos um link para abrir o QR como imagem no navegador.
// ===============================
client.on("qr", async (qr) => {
  try {
    qrAtualTexto = qr;
    qrGeradoEm = new Date().toISOString();

    // Também geramos Data URL para deixar salvo em memória, caso você queira usar depois.
    qrAtualDataUrl = await QRCode.toDataURL(qr, {
      width: 420,
      margin: 2,
      errorCorrectionLevel: "M"
    });

    const baseUrl = obterUrlBaseBot();
    // Logamos apenas o formato da URL; o token real fica fora do terminal.
    const qrPageUrl = `${baseUrl}/qr?token=SEU_TOKEN`;
    const qrImageUrl = `${baseUrl}/qr.png?token=SEU_TOKEN`;

    console.log("📲 Novo QR Code gerado.");
    console.log(`🔗 Página do QR: ${qrPageUrl}`);
    console.log(`🖼️ Imagem direta: ${qrImageUrl}`);

    if (!QR_PAGE_TOKEN) {
      console.log("⚠️ Configure QR_PAGE_TOKEN no .env local para liberar a visualização do QR.");
    }
  } catch (err) {
    console.error("❌ Erro ao preparar QR Code:", err);
  }
});

// ===============================
// QUANDO O WHATSAPP ESTÁ PRONTO
// ===============================
// ===============================
// CODIGO DE PAREAMENTO DO WHATSAPP
// Mantem o ultimo codigo em memoria para status e evita expor o codigo nos logs.
// ===============================
client.on("code", (code) => {
  codigoPareamentoAtual = code;
  codigoPareamentoGeradoEm = new Date().toISOString();

  console.log("🔐 Novo código de pareamento recebido para o WhatsApp.");
});

client.on("ready", () => {
  botPronto = true;
  botProntoDesde = Date.now();

  // Quando conecta, limpamos o QR para não deixar QR antigo disponível.
  qrAtualTexto = null;
  qrAtualDataUrl = null;
  qrGeradoEm = null;
  codigoPareamentoAtual = null;
  codigoPareamentoGeradoEm = null;

  console.log("✅ NOVO MOTOR CONECTADO COM SUCESSO!");
});

// ===============================
// CASO O WHATSAPP PERCA CONEXÃO
// ===============================
client.on("disconnected", (reason) => {
  botPronto = false;
  console.log("❌ WhatsApp desconectado:", reason);
});

// ===============================
// CASO DÊ ERRO DE AUTENTICAÇÃO
// ===============================
client.on("auth_failure", (msg) => {
  botPronto = false;

  // Se falhar autenticação, provavelmente será necessário gerar novo QR.
  qrAtualTexto = null;
  qrAtualDataUrl = null;
  qrGeradoEm = null;
  codigoPareamentoAtual = null;
  codigoPareamentoGeradoEm = null;

  console.log("❌ Falha de autenticação:", msg);
});

// ===============================
// FUNÇÃO: LIMPAR TELEFONE
// Remove tudo que não for número
// Exemplo:
// "+55 27 99713-6155" vira "5527997136155"
// ===============================
function limparTelefone(valor) {
  return String(valor || "").replace(/\D/g, "");
}

function numeroTemDdiBrasil(valor) {
  // Telefone BR: so considera 55 como DDI quando existem DDI + DDD + numero local.
  const numero = limparTelefone(valor);
  return numero.startsWith("55") && numero.length > 11;
}

function removerDdiBrasilSeInformado(valor) {
  // Telefone BR: preserva numeros locais com DDD 55 e remove apenas o DDI 55 real.
  const numero = limparTelefone(valor);
  return numeroTemDdiBrasil(numero) ? numero.slice(2) : numero;
}

// ===============================
// FUNÇÃO: NORMALIZAR TELEFONE DE ENTRADA
// Mantém apenas dígitos para comparar, salvar e validar o WhatsApp com segurança.
// ===============================
function normalizarTelefoneEntrada(valor) {
  return limparTelefone(valor);
}

// ===============================
// FUNÇÃO: VALIDAR TELEFONE BRASILEIRO COM DDD
// Aceita números com ou sem 55, mas exige DDD e 8 ou 9 dígitos locais.
// ===============================
function validarTelefoneBrasileiroComDdd(telefone) {
  const numeroSemPais = removerDdiBrasilSeInformado(telefone);

  return /^[1-9]{2}\d{8,9}$/.test(numeroSemPais);
}

function normalizarTelefonePareamentoBrasil(telefone) {
  // Pareamento WhatsApp: requestPairingCode exige numero internacional sem simbolos, entao montamos 55 + DDD + numero.
  const numeroSemPais = removerDdiBrasilSeInformado(telefone);

  if (!validarTelefoneBrasileiroComDdd(numeroSemPais)) {
    return "";
  }

  return `55${numeroSemPais}`;
}

// ===============================
// FUNÇÃO: VALIDAR NOME MÍNIMO
// Evita cadastro/agendamento com nome vazio ou curto demais para conferência da equipe.
// ===============================
function validarNomeMinimo(nome) {
  return String(nome || "").trim().replace(/\s+/g, " ").length >= 2;
}

// ===============================
// FUNÇÃO: NORMALIZAR NÚMERO DO WHATSAPP
// Aceita número puro ou número já terminado em @c.us.
// ===============================
function normalizarNumeroWhatsApp(telefone) {
  const valorOriginal = String(telefone || "").trim();
  const semSufixo = valorOriginal.replace(/@c\.us$/i, "");
  const numero = limparTelefone(semSufixo);

  if (!numero) return "";

  // Mantem compatibilidade com DDD 55: so remove DDI real antes de montar o formato do WhatsApp.
  const numeroComPais = "55" + removerDdiBrasilSeInformado(numero);

  return `${numeroComPais}@c.us`;
}

// ===============================
// FUNÇÃO: MASCARAR NÚMERO PARA LOG
// Ajuda a depurar sem expor o telefone completo no terminal.
// ===============================
function mascararNumeroWhatsApp(destino) {
  const numero = limparTelefone(destino);

  if (numero.length <= 4) return destino || "não informado";

  return `***${numero.slice(-4)}@c.us`;
}

// ===============================
// FUNÇÃO: GERAR VARIAÇÕES DO TELEFONE
// Isso ajuda a comparar números em formatos diferentes:
// 27997136155
// 5527997136155
// 2797136155
// 552797136155
// ===============================
async function resolverDestinoWhatsApp(telefone) {
  const variantes = gerarVariantesTelefone(telefone);
  const candidatos = new Set();

  for (const variante of variantes) {
    const numero = limparTelefone(variante);
    if (!numero) continue;

    candidatos.add(numeroTemDdiBrasil(numero) ? numero : `55${numero}`);
  }

  for (const numero of candidatos) {
    try {
      const numberId = await client.getNumberId(numero);

      if (numberId && numberId._serialized) {
        return numberId._serialized;
      }
    } catch (err) {
      console.warn(`⚠️ Não foi possível validar o WhatsApp ${mascararNumeroWhatsApp(numero)}:`, err.message || err);
    }
  }

  return normalizarNumeroWhatsApp(telefone);
}

function gerarVariantesTelefone(valor) {
  const numero = limparTelefone(valor);

  if (!numero) return [];

  const variantes = new Set();

  function adicionar(n) {
    if (!n) return;

    variantes.add(n);

    // Telefone BR: so trata 55 como DDI quando o numero tem DDI + DDD + telefone.
    if (numeroTemDdiBrasil(n)) {
      variantes.add(removerDdiBrasilSeInformado(n));
    } else {
      // Se nao tem DDI, tambem testa com 55 para manter compatibilidade com registros antigos.
      variantes.add("55" + n);
    }
  }

  adicionar(numero);

  const sem55 = removerDdiBrasilSeInformado(numero);

  adicionar(sem55);

  // Caso 1:
  // Número com DDD + 9º dígito
  // Exemplo: 27997136155
  // Também testa sem o 9:
  // 2797136155
  if (sem55.length === 11 && sem55[2] === "9") {
    const semNonoDigito = sem55.slice(0, 2) + sem55.slice(3);
    adicionar(semNonoDigito);
  }

  // Caso 2:
  // Número com DDD sem o 9º dígito
  // Exemplo: 2797136155
  // Também testa com o 9:
  // 27997136155
  if (sem55.length === 10) {
    const comNonoDigito = sem55.slice(0, 2) + "9" + sem55.slice(2);
    adicionar(comNonoDigito);
  }

  return [...variantes];
}

// ===============================
// CAMPOS DE USUARIO PARA BUSCAS POR TELEFONE
// Mantem as consultas leves trazendo apenas dados usados no agendamento, cadastro e bot.
// ===============================
const CAMPOS_USUARIO_TELEFONE = [
  "id",
  "nome",
  "telefone",
  "data_nascimento",
  "cadastrado",
  "status",
  "faltas",
  "origem_cadastro"
].join(", ");

function adicionarFormatosHumanosTelefone(candidatos, numeroSemPais) {
  // Performance Supabase: inclui formatos antigos comuns para evitar buscar todos os usuarios quando o telefone esta mascarado.
  if (![10, 11].includes(numeroSemPais.length)) return;

  const ddd = numeroSemPais.slice(0, 2);
  const local = numeroSemPais.slice(2);
  const cortePrefixo = local.length === 9 ? 5 : 4;
  const prefixo = local.slice(0, cortePrefixo);
  const sufixo = local.slice(cortePrefixo);

  candidatos.add(`(${ddd}) ${prefixo}-${sufixo}`);
  candidatos.add(`${ddd} ${prefixo}-${sufixo}`);
  candidatos.add(`${ddd} ${prefixo} ${sufixo}`);
  candidatos.add(`+55 ${ddd} ${prefixo}-${sufixo}`);
  candidatos.add(`55 ${ddd} ${prefixo}-${sufixo}`);

  if (local.length === 9) {
    // Performance Supabase: cobre mascaras irregulares como "(27) 9 9999-9999" sem buscar a tabela inteira.
    const nonoDigito = local.slice(0, 1);
    const blocoMeio = local.slice(1, 5);
    const blocoFinal = local.slice(5);

    candidatos.add(`(${ddd}) ${nonoDigito} ${blocoMeio}-${blocoFinal}`);
    candidatos.add(`${ddd} ${nonoDigito} ${blocoMeio}-${blocoFinal}`);
    candidatos.add(`+55 ${ddd} ${nonoDigito} ${blocoMeio}-${blocoFinal}`);
    candidatos.add(`55 ${ddd} ${nonoDigito} ${blocoMeio}-${blocoFinal}`);
  }
}

function gerarCandidatosTelefoneExato(variantesTelefone) {
  // Performance Supabase: gera valores exatos provaveis para usar IN no banco antes de qualquer fallback parcial.
  const candidatos = new Set();

  for (const variante of variantesTelefone) {
    const numero = limparTelefone(variante);
    if (!numero) continue;

    candidatos.add(numero);
    candidatos.add(`+${numero}`);
    candidatos.add(`${numero}@c.us`);

    const semPais = removerDdiBrasilSeInformado(numero);
    adicionarFormatosHumanosTelefone(candidatos, semPais);
  }

  return [...candidatos];
}

function gerarFiltrosTelefoneParcial(variantesTelefone) {
  // Performance Supabase: cria filtros por DDD, prefixo e final do numero para buscar poucos candidatos legados.
  const filtros = new Map();

  for (const variante of variantesTelefone) {
    const numero = limparTelefone(variante);
    const semPais = removerDdiBrasilSeInformado(numero);

    if (![10, 11].includes(semPais.length)) continue;

    const ddd = semPais.slice(0, 2);
    const local = semPais.slice(2);
    // Performance Supabase: usa o miolo que tambem aparece em mascaras com nono digito separado.
    const prefixo = local.length === 9 ? local.slice(1, 5) : local.slice(0, 4);
    const sufixo = local.slice(-4);

    if (ddd.length === 2 && prefixo.length >= 4 && sufixo.length === 4) {
      filtros.set(`${ddd}|${prefixo}|${sufixo}`, { ddd, prefixo, sufixo });
    }
  }

  return [...filtros.values()];
}

function montarFiltroParcialTelefoneSupabase(filtros) {
  // Performance Supabase: monta OR com grupos AND para aceitar telefone cru ou mascarado sem carregar a tabela inteira.
  return filtros
    .map(({ ddd, prefixo, sufixo }) =>
      `and(telefone.ilike.*${ddd}*,telefone.ilike.*${prefixo}*,telefone.ilike.*${sufixo}*)`
    )
    .join(",");
}

function encontrarUsuarioPorVariantesTelefone(usuarios, variantesTelefone) {
  // Comparacao final: mantem a regra flexivel existente usando as mesmas variacoes de telefone em memoria.
  const variantesAlvo = new Set(variantesTelefone);

  return (usuarios || []).find((usuario) => {
    const variantesBanco = gerarVariantesTelefone(usuario.telefone);

    return variantesBanco.some((numeroBanco) =>
      variantesAlvo.has(numeroBanco)
    );
  }) || null;
}

async function consultarUsuariosPorTelefoneExato(variantesTelefone) {
  // Performance Supabase: consulta por igualdade usa valores normalizados e reduz trafego antes do fallback.
  const candidatosExatos = gerarCandidatosTelefoneExato(variantesTelefone);

  if (!candidatosExatos.length) {
    return [];
  }

  const { data, error } = await supabase
    .from("usuarios")
    .select(CAMPOS_USUARIO_TELEFONE)
    .in("telefone", candidatosExatos);

  if (error) {
    throw error;
  }

  return data || [];
}

async function consultarUsuariosPorTelefoneParcial(variantesTelefone) {
  // Performance Supabase: fallback limitado para telefones antigos com mascara, sem fazer select geral de usuarios.
  const filtros = gerarFiltrosTelefoneParcial(variantesTelefone);
  const filtroSupabase = montarFiltroParcialTelefoneSupabase(filtros);

  if (!filtroSupabase) {
    return [];
  }

  const { data, error } = await supabase
    .from("usuarios")
    .select(CAMPOS_USUARIO_TELEFONE)
    .or(filtroSupabase);

  if (error) {
    throw error;
  }

  return data || [];
}

async function buscarUsuarioPorVariantesTelefone(variantesTelefone) {
  // Performance Supabase: tenta primeiro candidatos exatos e so usa busca parcial se necessario.
  const usuariosExatos = await consultarUsuariosPorTelefoneExato(variantesTelefone);
  const usuarioExato = encontrarUsuarioPorVariantesTelefone(usuariosExatos, variantesTelefone);

  if (usuarioExato) {
    return {
      usuario: usuarioExato,
      estrategia: "exata",
      totalCandidatos: usuariosExatos.length
    };
  }

  const usuariosParciais = await consultarUsuariosPorTelefoneParcial(variantesTelefone);
  const usuarioParcial = encontrarUsuarioPorVariantesTelefone(usuariosParciais, variantesTelefone);

  return {
    usuario: usuarioParcial,
    estrategia: "parcial",
    totalCandidatos: usuariosExatos.length + usuariosParciais.length
  };
}

// ===============================
// FUNÇÃO: CALCULAR IDADE
// Usa a data de nascimento cadastrada no Supabase.
// ===============================
function calcularIdade(dataNascimento) {
  if (!dataNascimento) return null;

  const partes = String(dataNascimento).split("T")[0].split("-");
  if (partes.length !== 3) return null;

  const [ano, mes, dia] = partes.map(Number);
  const nascimento = new Date(ano, mes - 1, dia);

  if (
    Number.isNaN(nascimento.getTime()) ||
    nascimento.getFullYear() !== ano ||
    nascimento.getMonth() !== mes - 1 ||
    nascimento.getDate() !== dia
  ) {
    return null;
  }

  const hoje = new Date();
  let idade = hoje.getFullYear() - nascimento.getFullYear();
  const aniversarioJaPassou =
    hoje.getMonth() > nascimento.getMonth() ||
    (hoje.getMonth() === nascimento.getMonth() && hoje.getDate() >= nascimento.getDate());

  if (!aniversarioJaPassou) {
    idade--;
  }

  return idade;
}

// ===============================
// FUNÇÃO: VALIDAR FAIXA ETÁRIA DO CRJ
// Usa a faixa etária configurada, com fallback igual à v1.0.
// ===============================
function idadePermitida(dataNascimento, config = DEFAULT_LABSTUDIO_CONFIG) {
  const idade = calcularIdade(dataNascimento);
  return idade !== null &&
    idade >= config.idade_minima &&
    idade <= config.idade_maxima;
}

// ===============================
// FUNÇÃO: VALIDAR DATA DE NASCIMENTO DE ENTRADA
// Quando informada, precisa ser uma data real, no formato ISO do formulário e não futura.
// ===============================
function validarDataNascimentoQuandoInformada(dataNascimento) {
  const valor = String(dataNascimento || "").trim();

  if (!valor) {
    return true;
  }

  const partes = valor.split("T")[0].split("-");

  if (partes.length !== 3 || !/^\d{4}-\d{2}-\d{2}$/.test(valor.split("T")[0])) {
    return false;
  }

  const [ano, mes, dia] = partes.map(Number);
  const data = new Date(ano, mes - 1, dia);

  if (
    Number.isNaN(data.getTime()) ||
    data.getFullYear() !== ano ||
    data.getMonth() !== mes - 1 ||
    data.getDate() !== dia
  ) {
    return false;
  }

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  data.setHours(0, 0, 0, 0);

  return data <= hoje;
}

// ===============================
// FUNÇÃO: VALIDAR DATA DE AGENDAMENTO
// Garante no servidor as regras de funcionamento configuradas.
// ===============================
function validarDataAgendamento(dataSelecionada, config = DEFAULT_LABSTUDIO_CONFIG) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dataSelecionada || ""))) {
    return {
      ok: false,
      mensagem: "Informe uma data válida para o agendamento."
    };
  }

  const dataObjeto = new Date(`${dataSelecionada}T12:00:00`);

  if (Number.isNaN(dataObjeto.getTime())) {
    return {
      ok: false,
      mensagem: "Informe uma data válida para o agendamento."
    };
  }

  // Segurança de produção: o frontend bloqueia datas passadas, mas a API precisa repetir a regra.
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const dataComparacao = new Date(`${dataSelecionada}T00:00:00`);

  if (dataComparacao < hoje) {
    return {
      ok: false,
      mensagem: "Escolha uma data de hoje em diante para o agendamento."
    };
  }

  const diaSemana = dataObjeto.getDay();

  if (!config.dias_funcionamento.includes(diaSemana)) {
    return {
      ok: false,
      mensagem: config.mensagem_funcionamento
    };
  }

  if (config.datas_bloqueadas.includes(dataSelecionada)) {
    return {
      ok: false,
      mensagem: "Esta data está reservada para evento interno ou feriado."
    };
  }

  return { ok: true };
}

// ===============================
// FUNÇÃO: BUSCAR USUÁRIO POR TELEFONE
// Usa consultas leves no Supabase e compara variações com/sem 55 e nono dígito.
// ===============================
async function buscarUsuarioPorTelefone(telefone) {
  const variantesDigitadas = gerarVariantesTelefone(telefone);

  if (variantesDigitadas.length === 0) {
    return {
      usuario: null,
      variantesDigitadas
    };
  }

  // Performance Supabase: evita carregar todos os usuarios para comparar telefone em memoria.
  const resultadoBusca = await buscarUsuarioPorVariantesTelefone(variantesDigitadas);

  return {
    usuario: resultadoBusca.usuario || null,
    variantesDigitadas
  };
}

// ===============================
// LIMITE DE AGENDAMENTOS FUTUROS POR PESSOA
// Compara pelos 8 últimos dígitos para ignorar +55, DDD e nono dígito.
// ===============================
const LIMITE_AGENDAMENTOS_FUTUROS_POR_PESSOA = 2;

async function contarAgendamentosFuturosDoUsuario(telefoneUsuario) {
  const final = limparTelefone(telefoneUsuario).slice(-8);
  if (!final) return 0;

  const agora = obterAgoraSaoPaulo();
  const hoje = `${agora.ano}-${String(agora.mes).padStart(2, "0")}-${String(agora.dia).padStart(2, "0")}`;

  const { data, error } = await supabase
    .from("agendamentos")
    .select("telefone")
    .eq("status", "agendado")
    .gte("data", hoje);

  if (error) {
    throw error;
  }

  return (data || []).filter((agendamento) => limparTelefone(agendamento.telefone).slice(-8) === final).length;
}

// ===============================
// FUNÇÃO: BUSCAR HORÁRIOS OCUPADOS
// Agendamentos cancelados não bloqueiam o horário.
// ===============================
async function buscarHorariosOcupados(dataSelecionada) {
  const { data: agendados, error } = await supabase
    .from("agendamentos")
    .select("horario, status")
    .eq("data", dataSelecionada)
    .neq("status", "cancelado");

  if (error) {
    console.error("❌ Falha ao consultar horários no Supabase:", error.message);
    throw error;
  }

  return (agendados || []).map((item) => String(item.horario || "").trim());
}

// ===============================
// FUNÇÃO: RESPOSTA DE ERRO PADRÃO DA API
// Mantém retornos JSON claros para as telas públicas.
// ===============================
function responderErroApi(res, status, mensagem, detalhes = null) {
  if (detalhes) {
    console.error("❌ Detalhes da API:", detalhes.message || detalhes);
  }

  return res.status(status).json({
    ok: false,
    mensagem
  });
}

// ===============================
// FUNÇÃO: RESPONDER PAYLOAD INVÁLIDO
// Centraliza erros de entrada para formulários públicos sem expor detalhes técnicos.
// ===============================
function responderPayloadInvalido(res, mensagem, status = 400) {
  return responderErroApi(res, status, mensagem || "Confira os dados enviados e tente novamente.");
}

// ===============================
// FUNÇÃO: IDENTIFICAR CONFLITO DE HORÁRIO NO BANCO
// Reconhece erro de constraint única do Postgres para retornar mensagem amigável ao usuário.
// ===============================
function erroConflitoHorarioAgendamento(error) {
  if (!error) return false;

  const codigo = String(error.code || "");
  const texto = [
    error.message,
    error.details,
    error.hint,
    error.constraint
  ].filter(Boolean).join(" ").toLowerCase();

  return codigo === "23505" &&
    (texto.includes("data") || texto.includes("horario") || texto.includes("horário"));
}

function obterBearerToken(req) {
  const cabecalho = String(req.headers.authorization || "");
  const match = cabecalho.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function verificarTokenInterno(req, res, next) {
  const tokenRecebido = obterBearerToken(req) || String(req.headers["x-internal-api-token"] || "");

  if (!INTERNAL_API_TOKEN) {
    return responderErroApi(res, 503, "Token interno não configurado no servidor.");
  }

  if (!segredoConfere(tokenRecebido, INTERNAL_API_TOKEN)) {
    return responderErroApi(res, 401, "Acesso não autorizado.");
  }

  return next();
}

async function exigirAdminSupabase(req, res, next) {
  const tokenRecebido = obterBearerToken(req);

  if (!tokenRecebido) {
    return responderErroApi(res, 401, "Sessão administrativa ausente.");
  }

  try {
    const { data: dadosUsuario, error: erroUsuario } = await supabase.auth.getUser(tokenRecebido);
    const usuarioAuth = dadosUsuario && dadosUsuario.user;

    if (erroUsuario || !usuarioAuth || !usuarioAuth.id) {
      return responderErroApi(res, 401, "Sessão administrativa inválida.");
    }

    const { data: adminAutorizado, error: erroAdmin } = await supabase
      .from("admin_users")
      .select("id, user_id, role, ativo")
      .eq("user_id", usuarioAuth.id)
      .eq("ativo", true)
      .eq("role", "admin")
      .maybeSingle();

    if (erroAdmin) {
      return responderErroApi(res, 500, "Erro ao validar permissão administrativa.", erroAdmin);
    }

    if (!adminAutorizado) {
      return responderErroApi(res, 403, "Usuário sem permissão administrativa.");
    }

    req.adminAuth = usuarioAuth;
    return next();
  } catch (err) {
    return responderErroApi(res, 500, "Erro ao validar sessão administrativa.", err);
  }
}

async function enviarNotificacaoAgendamento({ nome, telefone, data, horario }) {
  const numeroB = normalizarNumeroWhatsApp(BOT_NOTIFY_NUMBER);

  if (!numeroB) {
    throw new Error("BOT_NOTIFY_NUMBER ausente ou inválido no servidor.");
  }

  if (!botPronto) {
    throw new Error("WhatsApp ainda não está pronto para enviar mensagens.");
  }

  const mensagem = `🚀 NOVO AGENDAMENTO

Nome: ${nome}
Telefone: ${telefone}
Data: ${data}
Horário: ${horario}`;

  await client.sendMessage(numeroB, mensagem);
  return mascararNumeroWhatsApp(numeroB);
}

async function enviarNotificacaoAprovacao({ nome, telefone }) {
  const telefoneLimpo = limparTelefone(telefone);

  if (!telefoneLimpo) {
    const erro = new Error("Telefone inválido ou ausente para enviar a aprovação.");
    erro.statusCode = 400;
    throw erro;
  }

  if (!botPronto) {
    const erro = new Error("WhatsApp ainda não está pronto para enviar aprovação.");
    erro.statusCode = 503;
    throw erro;
  }

  const destino = await resolverDestinoWhatsApp(telefoneLimpo);

  if (!destino) {
    const erro = new Error("Não encontrei esse telefone como WhatsApp válido para enviar a aprovação.");
    erro.statusCode = 400;
    throw erro;
  }

  const mensagem = `Olá, ${nome || "jovem"}!

Seu cadastro no LabStudio CRJ FLEXAL foi aprovado pela equipe do CRJ.

Agora você já pode solicitar seu agendamento pelo link abaixo:
${PUBLIC_SITE_URL}/

Aguardamos você para realizar sua gravação! 🔥`;

  await client.sendMessage(destino, mensagem);
  return mascararNumeroWhatsApp(destino);
}

// ===============================
// FUNÇÃO: BUSCAR USUÁRIO PELO WHATSAPP
// Essa função:
// 1. pega o número de quem mandou mensagem;
// 2. gera variações desse número;
// 3. consulta candidatos no Supabase sem carregar todos os usuários;
// 4. compara os números de forma flexível.
// ===============================
async function buscarUsuarioPorWhatsApp(msg) {
  let telefonesDetectados = [];

  try {
    const contato = await msg.getContact();

    // Número do contato quando disponível.
    if (contato.number) {
      telefonesDetectados.push(contato.number);
    }

    // ID interno do WhatsApp quando disponível.
    if (contato.id && contato.id.user) {
      telefonesDetectados.push(contato.id.user);
    }
  } catch (err) {
    console.log("⚠️ Não consegui pegar contato:", err.message);
  }

  // Fallback: pega o número direto do msg.from.
  // Exemplo: 5527997136155@c.us vira 5527997136155.
  if (msg.from) {
    telefonesDetectados.push(String(msg.from).split("@")[0]);
  }

  // Cria todas as variações possíveis do número da pessoa.
  const variantesMensagem = [
    ...new Set(telefonesDetectados.flatMap(gerarVariantesTelefone))
  ];

  console.log(`📱 Telefones detectados: ${telefonesDetectados.length}. Variantes para busca: ${variantesMensagem.length}.`);

  let resultadoBusca;

  try {
    // Performance Supabase: busca apenas candidatos provaveis e mantem a comparacao flexivel no final.
    resultadoBusca = await buscarUsuarioPorVariantesTelefone(variantesMensagem);
  } catch (error) {
    console.error("❌ Falha ao consultar usuários no Supabase:", error.message);
    return {
      usuario: null,
      telefonesDetectados,
      variantesMensagem,
      error
    };
  }

  const usuarioEncontrado = resultadoBusca.usuario || null;

  if (usuarioEncontrado) {
    console.log(
      `✅ Usuário encontrado por busca ${resultadoBusca.estrategia}: ${usuarioEncontrado.nome} - ${mascararNumeroWhatsApp(usuarioEncontrado.telefone)}`
    );
  } else {
    console.log(`❌ Nenhum usuário encontrado para esse número. Candidatos consultados: ${resultadoBusca.totalCandidatos}.`);
  }

  return {
    usuario: usuarioEncontrado || null,
    telefonesDetectados,
    variantesMensagem,
    error: null
  };
}

// ===============================
// API PÚBLICA: HORÁRIOS DISPONÍVEIS
// O frontend consulta esta rota em vez de acessar agendamentos direto no Supabase.
// ===============================
// Segurança de rota pública: limita varredura de datas e excesso de consultas de disponibilidade.
app.get("/api/horarios", limitarConsultasPublicas, async (req, res) => {
  const dataSelecionada = String(req.query.data || "").trim();

  const config = await obterConfigLabStudioSegura();
  const validacaoData = validarDataAgendamento(dataSelecionada, config);

  if (!validacaoData.ok) {
    return responderErroApi(res, 400, validacaoData.mensagem);
  }

  try {
    const ocupados = await buscarHorariosOcupados(dataSelecionada);
    const horariosDisponiveis = config.horarios_disponiveis.filter((hora) =>
      !ocupados.includes(hora)
    );

    return res.json({
      ok: true,
      data: dataSelecionada,
      ocupados,
      horarios: horariosDisponiveis,
      horariosDisponiveis
    });
  } catch (err) {
    return responderErroApi(
      res,
      500,
      "Erro ao consultar horários disponíveis.",
      err
    );
  }
});

// ===============================
// API PÚBLICA: CRIAR AGENDAMENTO
// Centraliza validação de cadastro, idade, faltas, status e horário ocupado.
// ===============================
// Segurança de rota pública: mantém limite de tentativas de agendamento por origem.
app.post("/api/agendar", limitarRequisicoes({
  janelaMs: 10 * 60 * 1000,
  maximo: 8,
  nome: "agendar"
}), async (req, res) => {
  // Validação de entrada: protege a rota contra payload ausente, array ou campos fora do formato esperado.
  const corpo = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const nome = String(corpo.nome || "").trim().replace(/\s+/g, " ");
  const telefoneLimpo = normalizarTelefoneEntrada(corpo.telefone);
  const dataSelecionada = String(corpo.data || "").trim();
  const horario = String(corpo.horario || "").trim();

  if (!nome || !telefoneLimpo || !dataSelecionada || !horario) {
    return responderPayloadInvalido(res, "Preencha todos os campos corretamente.");
  }

  // Validação de entrada: nome mínimo ajuda a equipe a identificar o agendamento no painel.
  if (!validarNomeMinimo(nome)) {
    return responderPayloadInvalido(res, "Informe um nome válido para o agendamento.");
  }

  // Validação de entrada: telefone precisa ter DDD brasileiro antes de consultar cadastro e WhatsApp.
  if (!validarTelefoneBrasileiroComDdd(telefoneLimpo)) {
    return responderPayloadInvalido(res, "Informe um WhatsApp brasileiro válido com DDD.");
  }

  const config = await obterConfigLabStudioSegura();
  const validacaoData = validarDataAgendamento(dataSelecionada, config);

  if (!validacaoData.ok) {
    return responderPayloadInvalido(res, validacaoData.mensagem);
  }

  if (!config.horarios_disponiveis.includes(horario)) {
    return responderPayloadInvalido(res, "Horário inválido para esta agenda.");
  }

  try {
    const { usuario } = await buscarUsuarioPorTelefone(telefoneLimpo);

    if (!usuario || usuario.cadastrado === false) {
      return responderErroApi(
        res,
        403,
        "⚠️ Você precisa estar cadastrado no CRJ antes de agendar. Procure a equipe presencialmente."
      );
    }

    if (!usuario.data_nascimento) {
      return responderErroApi(
        res,
        403,
        "Seu cadastro precisa ser atualizado com a data de nascimento. Procure a equipe do CRJ."
      );
    }

    if (!idadePermitida(usuario.data_nascimento, config)) {
      return responderErroApi(
        res,
        403,
        `${mensagemFaixaEtaria(config)} Procure a equipe do CRJ.`
      );
    }

    const statusUsuario = String(usuario.status || "").toLowerCase();
    const faltasUsuario = Number(usuario.faltas || 0);

    if (statusUsuario === "bloqueado" || faltasUsuario >= config.limite_faltas_bloqueio) {
      return responderErroApi(
        res,
        403,
        "🚫 Você está bloqueado por faltas. Procure a equipe do CRJ para regularizar sua situação."
      );
    }

    if (statusUsuario && statusUsuario !== "ativo") {
      return responderErroApi(
        res,
        403,
        "Seu cadastro ainda não está ativo para agendamento. Procure a equipe do CRJ."
      );
    }

    // Impede que alguém ocupe a agenda inteira com o telefone de um jovem.
    const agendamentosFuturos = await contarAgendamentosFuturosDoUsuario(usuario.telefone);

    if (agendamentosFuturos >= LIMITE_AGENDAMENTOS_FUTUROS_POR_PESSOA) {
      return responderErroApi(
        res,
        409,
        `Você já tem ${agendamentosFuturos} agendamento(s) marcado(s). Compareça ou cancele com a equipe do CRJ antes de agendar outro.`
      );
    }

    const ocupados = await buscarHorariosOcupados(dataSelecionada);

    // Estabilidade de agendamento: checagem clara antes do insert evita tentativa desnecessária em horário já ocupado.
    if (ocupados.includes(horario)) {
      return responderErroApi(
        res,
        409,
        "Este horário acabou de ser ocupado. Escolha outro horário."
      );
    }

    const { data: agendamentoCriado, error } = await supabase
      .from("agendamentos")
      .insert([{
        nome,
        telefone: telefoneLimpo,
        data: dataSelecionada,
        horario,
        status: "agendado"
      }])
      .select("id, nome, telefone, data, horario, status")
      .single();

    if (error) {
      // Estabilidade de agendamento: a proteção ideal depende de constraint única no banco para cobrir cliques simultâneos.
      if (erroConflitoHorarioAgendamento(error)) {
        return responderErroApi(
          res,
          409,
          "Este horário acabou de ser ocupado por outra pessoa. Escolha outro horário."
        );
      }

      return responderErroApi(res, 500, "Erro ao salvar agendamento.", error);
    }

    // Divulgação: quem agenda passa a receber os lembretes quinzenais. Falha aqui não afeta o agendamento.
    try {
      await marcarUsuarioComoJaUsouEstudio(usuario.id);
    } catch (marcacaoError) {
      console.warn("⚠️ Agendamento salvo, mas não consegui marcar o jovem como já usou o estúdio:", marcacaoError.message || marcacaoError);
    }

    let whatsappNotificacaoEnviado = false;
    let destinoNotificacao = null;

    try {
      destinoNotificacao = await enviarNotificacaoAgendamento({
        nome: agendamentoCriado.nome || nome,
        telefone: agendamentoCriado.telefone || telefoneLimpo,
        data: agendamentoCriado.data || dataSelecionada,
        horario: agendamentoCriado.horario || horario
      });
      whatsappNotificacaoEnviado = true;
      console.log(`✅ Notificação de agendamento enviada para ${destinoNotificacao}.`);
    } catch (zapError) {
      console.warn("⚠️ Agendamento salvo, mas a notificação WhatsApp falhou:", zapError.message || zapError);
    }

    return res.json({
      ok: true,
      mensagem: `Confirmado, ${nome}! 🔥\nTe esperamos dia ${dataSelecionada} às ${horario}.`,
      agendamento: agendamentoCriado,
      whatsappNotificacaoEnviado,
      destinoNotificacao
    });
  } catch (err) {
    return responderErroApi(res, 500, "Erro ao processar agendamento.", err);
  }
});

// ===============================
// API PÚBLICA: CADASTRO ONLINE
// Salva solicitações públicas como pendentes usando service role somente no servidor.
// ===============================
// Segurança de rota pública: cadastro tem limite maior porque vários jovens podem usar a mesma rede do CRJ.
app.post("/api/cadastro-online", limitarRequisicoes({
  janelaMs: 30 * 60 * 1000,
  maximo: 20,
  nome: "cadastro-online"
}), async (req, res) => {
  // Validação de entrada: aceita o formato atual do frontend e evita campos inesperados quebrando a rota.
  const corpo = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const nome = String(corpo.nome || "").trim().replace(/\s+/g, " ");
  const telefoneLimpo = normalizarTelefoneEntrada(corpo.telefone);
  const dataNascimento = String(corpo.data_nascimento || corpo.dataNascimento || "").trim();

  if (!nome || !telefoneLimpo || !dataNascimento) {
    return responderPayloadInvalido(
      res,
      "Preencha nome completo, WhatsApp e data de nascimento."
    );
  }

  // Validação de entrada: nome mínimo evita solicitações sem identificação útil para análise.
  if (!validarNomeMinimo(nome)) {
    return responderPayloadInvalido(res, "Informe um nome válido para o cadastro.");
  }

  // Validação de entrada: telefone precisa ter DDD brasileiro para análise e contato pelo WhatsApp.
  if (!validarTelefoneBrasileiroComDdd(telefoneLimpo)) {
    return responderPayloadInvalido(res, "Informe um WhatsApp brasileiro válido com DDD.");
  }

  // Validação de entrada: data inválida ou futura não deve cair como erro genérico de faixa etária.
  if (!validarDataNascimentoQuandoInformada(dataNascimento)) {
    return responderPayloadInvalido(res, "Informe uma data de nascimento válida.");
  }

  const config = await obterConfigLabStudioSegura();

  if (!idadePermitida(dataNascimento, config)) {
    return responderPayloadInvalido(res, mensagemFaixaEtariaCrj(config));
  }

  try {
    const { usuario: usuarioExistente } = await buscarUsuarioPorTelefone(telefoneLimpo);

    if (usuarioExistente) {
      const statusExistente = String(usuarioExistente.status || "").toLowerCase();
      const origemCadastro = String(usuarioExistente.origem_cadastro || "").toLowerCase();

      if (
        statusExistente === "pendente" ||
        (usuarioExistente.cadastrado === false && origemCadastro === "online")
      ) {
        return responderErroApi(
          res,
          409,
          "Seu cadastro online já foi enviado e está aguardando análise da equipe."
        );
      }

      return responderErroApi(
        res,
        409,
        "Este número já possui cadastro. Chame o atendimento pelo WhatsApp para continuar."
      );
    }

    const { error } = await supabase
      .from("usuarios")
      .insert([{
        nome,
        telefone: telefoneLimpo,
        data_nascimento: dataNascimento,
        cadastrado: false,
        status: "pendente",
        faltas: 0,
        presencas: 0,
        origem_cadastro: "online",
        cadastro_online_em: new Date().toISOString(),
        observacao: "Cadastro realizado online"
      }]);

    if (error) {
      return responderErroApi(res, 500, "Erro ao enviar cadastro.", error);
    }

    let whatsappConfirmacaoEnviado = false;

    try {
      if (botPronto) {
        const destinoConfirmacao = await resolverDestinoWhatsApp(telefoneLimpo);

        if (!destinoConfirmacao) {
          throw new Error("telefone_invalido");
        }

        const mensagemConfirmacao = `Olá, ${nome}!

Recebemos seu cadastro online no LabStudio CRJ FLEXAL.

Agora a equipe do CRJ vai analisar seus dados. Quando o cadastro for aprovado, você receberá uma nova mensagem com o link para solicitar o agendamento.

Obrigado pelo cadastro!`;

        await client.sendMessage(destinoConfirmacao, mensagemConfirmacao);
        whatsappConfirmacaoEnviado = true;

        console.log(`✅ Confirmação de cadastro enviada para ${mascararNumeroWhatsApp(destinoConfirmacao)}.`);
      } else {
        console.warn("⚠️ Cadastro salvo, mas o WhatsApp não estava pronto para enviar confirmação.");
      }
    } catch (zapError) {
      console.error("❌ Cadastro salvo, mas falhou ao enviar confirmação pelo WhatsApp:", zapError);
    }

    return res.json({
      ok: true,
      mensagem: "Cadastro enviado com sucesso! A equipe do CRJ irá analisar seus dados. Após aprovação, você poderá solicitar o agendamento pelo WhatsApp.",
      whatsappConfirmacaoEnviado
    });
  } catch (err) {
    return responderErroApi(res, 500, "Erro ao processar cadastro online.", err);
  }
});

// ===============================
// AUTOATENDIMENTO DO WHATSAPP
// Detecta palavras-chave e decide se envia o link.
// ===============================
const TEMPO_GATILHO_LABSTUDIO_MS = 30 * 60 * 1000;
const gatilhosLabStudioPorContato = new Map();

function mensagemContemGatilhoLabStudio(mensagemNormalizada) {
  // Gatilhos operacionais restritos ao LabStudio, com ou sem acento.
  const gatilhos = [
    "agendar",
    "agendamento",
    "labstudio",
    "estudio",
    "studio",
    "gravar",
    "gravacao",
    "musica"
  ];

  return gatilhos.some((gatilho) => mensagemNormalizada.includes(gatilho));
}

function registrarGatilhoLabStudio(contato) {
  // Memória temporária por contato: só conversas que acionaram gatilho podem receber respostas do bot.
  if (!contato) return;

  gatilhosLabStudioPorContato.set(contato, Date.now());
}

function conversaTemGatilhoRecente(contato) {
  // A janela de 30 minutos evita que erros ou orientações sejam enviados para quem não chamou o LabStudio.
  if (!contato) return false;

  const acionadoEm = gatilhosLabStudioPorContato.get(contato);

  if (!acionadoEm) return false;

  const gatilhoAindaValido = Date.now() - acionadoEm <= TEMPO_GATILHO_LABSTUDIO_MS;

  if (!gatilhoAindaValido) {
    gatilhosLabStudioPorContato.delete(contato);
  }

  return gatilhoAindaValido;
}

async function processarMensagemWhatsApp(msg) {
  try {
    // Ignora mensagens enviadas pelo próprio bot.
    if (msg.fromMe) return;

    // Ignora mensagens de sistema, broadcast ou grupo que não devem ser processadas.
    const origem = String(msg.from || "").toLowerCase();
    if (
      origem.endsWith("@broadcast") ||
      origem.endsWith("@g.us") ||
      origem.startsWith("status") ||
      origem.includes("status@")
    ) {
      return;
    }

    // Ignora mensagens vazias.
    if (!msg.body) return;

    // Evita resposta duplicada só depois de confirmar que existe texto para processar.
    if (mensagemWhatsAppJaProcessada(msg)) return;

    const mensagemRecebida = msg.body.toLowerCase();
    const mensagemNormalizada = mensagemRecebida
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Descadastro da divulgação: tratado antes dos gatilhos para não responder com o link de agendamento.
    if (mensagemPedeSairDaDivulgacao(mensagemNormalizada)) {
      await processarPedidoSairDivulgacao(msg);
      return;
    }

    const encontrouGatilho = mensagemContemGatilhoLabStudio(mensagemNormalizada);

    // Se não encontrou gatilho, não faz nada.
    if (!encontrouGatilho) return;

    registrarGatilhoLabStudio(msg.from);

    // O número é mascarado para manter diagnóstico sem expor telefone completo.
    console.log(`📩 Gatilho recebido de: ${mascararNumeroWhatsApp(msg.from)}`);

    // Busca o usuário no Supabase antes de mandar o link.
    const {
      usuario,
      telefonesDetectados,
      variantesMensagem,
      error
    } = await buscarUsuarioPorWhatsApp(msg);

    // Caso dê erro ao consultar Supabase.
    if (error) {
      console.log("❌ Erro ao consultar cadastro:", error.message);

      if (conversaTemGatilhoRecente(msg.from)) {
        await client.sendMessage(
          msg.from,
          "No momento não consegui consultar seu cadastro. Tente novamente mais tarde ou procure a equipe do CRJ."
        );
      }

      return;
    }

    // Se não encontrar o usuário, envia o link para cadastro online.
    if (!usuario) {
      if (conversaTemGatilhoRecente(msg.from)) {
        await client.sendMessage(
          msg.from,
          `Olá! Para agendar o LabStudio CRJ FLEXAL, é necessário estar cadastrado no CRJ.

Identificamos que este número ainda não consta em nosso cadastro.

Você pode realizar seu cadastro online pelo link abaixo:
${PUBLIC_SITE_URL}/cadastro.html

Após o envio, aguarde a análise da equipe do CRJ.`
        );
      }

      console.log(`❌ Usuário não cadastrado. Variantes testadas: ${variantesMensagem.length}.`);

      return;
    }

    const config = await obterConfigLabStudioSegura();

    // Normaliza status e faltas para evitar erro de comparação.
    const statusUsuario = String(usuario.status || "").toLowerCase();
    const faltasUsuario = Number(usuario.faltas || 0);

    // Se estiver bloqueado ou tiver faltas no limite configurado.
    if (statusUsuario === "bloqueado" || faltasUsuario >= config.limite_faltas_bloqueio) {
      if (conversaTemGatilhoRecente(msg.from)) {
        await client.sendMessage(
          msg.from,
          `Olá, ${usuario.nome || "jovem"}.

No momento, seu acesso ao agendamento do LabStudio está bloqueado por faltas anteriores.

📍 Procure presencialmente a equipe do CRJ para regularizar sua situação.`
        );
      }

      console.log(`🚫 Usuário bloqueado: ${mascararNumeroWhatsApp(usuario.telefone)}`);

      return;
    }

    // Se o cadastro online existe, mas ainda não foi aprovado pela equipe.
    if (statusUsuario === "pendente" || usuario.cadastrado === false) {
      if (conversaTemGatilhoRecente(msg.from)) {
        await client.sendMessage(
          msg.from,
          "Seu cadastro online foi recebido e está aguardando análise da equipe do CRJ. Assim que for aprovado, você poderá solicitar o agendamento pelo WhatsApp."
        );
      }

      console.log(`⏳ Usuário pendente de aprovação: ${mascararNumeroWhatsApp(usuario.telefone)}`);

      return;
    }

    // ===============================
    // VERIFICAR DATA DE NASCIMENTO E IDADE
    // Bloqueia antes de enviar o link quando o cadastro está incompleto.
    // ===============================
    if (!usuario.data_nascimento) {
      if (conversaTemGatilhoRecente(msg.from)) {
        await client.sendMessage(
          msg.from,
          `Olá, ${usuario.nome || "jovem"}.

Seu cadastro precisa ser atualizado com a data de nascimento antes de acessar o agendamento do LabStudio.

📍 Procure presencialmente a equipe do CRJ para atualizar seu cadastro.`
        );
      }

      console.log(`⚠️ Usuário sem data de nascimento: ${mascararNumeroWhatsApp(usuario.telefone)}`);

      return;
    }

    if (!idadePermitida(usuario.data_nascimento, config)) {
      if (conversaTemGatilhoRecente(msg.from)) {
        await client.sendMessage(
          msg.from,
          `Olá, ${usuario.nome || "jovem"}.

${mensagemFaixaEtaria(config)}

📍 Procure presencialmente a equipe do CRJ para mais orientações.`
        );
      }

      console.log(`🚫 Usuário fora da faixa etária: ${mascararNumeroWhatsApp(usuario.telefone)}`);

      return;
    }

    // ===============================
    // MENSAGEM PADRÃO DO LABSTUDIO
    // ===============================
    const resposta = `Olá! Você está em contato com o atendimento automático do LabStudio CRJ FLEXAL. 🎙️

Identificamos que você tem interesse em utilizar nossos serviços de estúdio. Para garantir a organização e o acesso de todos, nossos agendamentos são realizados exclusivamente através do nosso portal oficial.

📍 Para agendar sua sessão, acesse o link abaixo:
${PUBLIC_SITE_URL}/

Orientações importantes:
1. Selecione a data e o horário desejados.
2. Certifique-se de comparecer no horário agendado para evitar atrasos nos demais atendimentos.
3. Caso precise cancelar, entre em contato com antecedência.

Aguardamos você para realizar sua gravação! 🔥`;

    if (conversaTemGatilhoRecente(msg.from)) {
      await client.sendMessage(msg.from, resposta);
    }

    console.log(
      `✅ Auto-resposta enviada para usuário cadastrado: ${usuario.nome} - ${mascararNumeroWhatsApp(usuario.telefone)}`
    );
  } catch (err) {
    console.error("❌ Erro inesperado ao processar mensagem do WhatsApp:", err);

    try {
      if (msg && msg.from && conversaTemGatilhoRecente(msg.from)) {
        await client.sendMessage(
          msg.from,
          "No momento tive um problema ao processar sua mensagem. Tente novamente mais tarde ou procure a equipe do CRJ."
        );
      }
    } catch (sendError) {
      console.error("❌ Falha ao enviar mensagem de erro pelo WhatsApp:", sendError);
    }
  }
}

client.on("message", processarMensagemWhatsApp);

client.on("message_create", async (msg) => {
  // Compatibilidade do bot: alguns ambientes do WhatsApp Web disparam melhor este evento; a função central evita duplicidade.
  await processarMensagemWhatsApp(msg);
});

// ===============================
// ROTA /notificar
// Rota manual/interna protegida por INTERNAL_API_TOKEN.
// O fluxo público normal notifica dentro de /api/agendar.
// ===============================
app.post("/notificar", verificarTokenInterno, async (req, res) => {
  const { nome, telefone, data, horario } = req.body;

  console.log(`📥 /notificar recebeu agendamento manual: data=${data || "sem data"}, horario=${horario || "sem horário"}`);

  // Envia a mensagem para o número configurado no .env.
  try {
    const destino = await enviarNotificacaoAgendamento({ nome, telefone, data, horario });

    console.log(`✅ Notificação enviada com sucesso para ${destino}.`);

    res.json({
      status: "enviado",
      destino
    });
  } catch (err) {
    console.error("❌ Falha ao enviar notificação pelo WhatsApp:", err);

    res.status(err.statusCode || 500).json({
      status: "erro",
      erro: "falha_ao_enviar",
      mensagem: err.message || "Falha desconhecida ao enviar WhatsApp."
    });
  }
});

// ===============================
// ROTA /notificar-aprovacao
// Envia para o jovem a confirmação de cadastro aprovado e o link de agendamento.
// ===============================
app.post("/notificar-aprovacao", exigirAdminSupabase, async (req, res) => {
  const { nome, telefone } = req.body;
  console.log(`📨 /notificar-aprovacao recebeu solicitação para ${mascararNumeroWhatsApp(telefone)}`);

  try {
    const destino = await enviarNotificacaoAprovacao({ nome, telefone });

    console.log(`✅ Aprovação enviada para ${mascararNumeroWhatsApp(destino)}`);
    res.json({
      status: "enviado",
      destino: mascararNumeroWhatsApp(destino)
    });
  } catch (err) {
    console.error("❌ Erro ao enviar aprovação:", err);
    res.status(err.statusCode || 500).json({
      erro: "falha_ao_enviar",
      mensagem: err.message || "Falha desconhecida ao enviar aprovação pelo WhatsApp."
    });
  }
});

// ===============================
// DIVULGAÇÃO QUINZENAL
// Dia 1 e dia 15, a partir das 11h (Brasília), o bot lembra quem já usou o estúdio
// que o LabStudio continua de portas abertas. Quem responder SAIR não recebe mais.
// Liga/desliga pelo .env: DIVULGACAO_ATIVA=true
// Precisa do SQL em supabase/divulgacao.sql.
// ===============================
const DIVULGACAO_ATIVA = String(process.env.DIVULGACAO_ATIVA || "").toLowerCase() === "true";
const DIVULGACAO_DIAS = [1, 15];
const DIVULGACAO_HORA_INICIO = 11;
// Não envia à noite: se o envio atrasar, para às 19h e continua no dia seguinte.
const DIVULGACAO_HORA_FIM = 19;
// Se o bot ficar fora do ar no dia do envio, ainda recupera o ciclo até 3 dias depois.
const DIVULGACAO_DIAS_TOLERANCIA = 3;
// Intervalo aleatório entre mensagens para não parecer disparo em massa.
const DIVULGACAO_INTERVALO_MIN_MS = 45 * 1000;
const DIVULGACAO_INTERVALO_MAX_MS = 120 * 1000;
// Espera depois de o WhatsApp conectar antes de começar a enviar.
const DIVULGACAO_ESPERA_APOS_CONECTAR_MS = 3 * 60 * 1000;

// Serviços divulgados na mensagem. Edite esta lista para mudar as ofertas.
const DIVULGACAO_SERVICOS = [
  "🎙️ Gravação de voz e música",
  "🎬 Produção de clipes"
];

let divulgacaoEmAndamento = false;

function obterAgoraSaoPaulo() {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(new Date())
      .map((parte) => [parte.type, parte.value])
  );

  return {
    ano: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    hora: Number(partes.hour)
  };
}

// Retorna o ciclo em andamento (ex.: "2026-10-15") ou null fora da janela de envio.
function obterCicloDivulgacaoAtual(agora = obterAgoraSaoPaulo()) {
  const diaCiclo = [...DIVULGACAO_DIAS].reverse().find((dia) => agora.dia >= dia);

  if (!diaCiclo) return null;
  if (agora.dia - diaCiclo > DIVULGACAO_DIAS_TOLERANCIA) return null;
  if (agora.hora < DIVULGACAO_HORA_INICIO || agora.hora >= DIVULGACAO_HORA_FIM) return null;

  const mes = String(agora.mes).padStart(2, "0");
  const dia = String(diaCiclo).padStart(2, "0");

  return `${agora.ano}-${mes}-${dia}`;
}

function obterProximoEnvioDivulgacao(agora = obterAgoraSaoPaulo()) {
  const proximoDia = DIVULGACAO_DIAS.find((dia) => dia > agora.dia || (dia === agora.dia && agora.hora < DIVULGACAO_HORA_INICIO));
  let ano = agora.ano;
  let mes = agora.mes;
  let dia = proximoDia;

  if (!dia) {
    dia = DIVULGACAO_DIAS[0];
    mes += 1;

    if (mes > 12) {
      mes = 1;
      ano += 1;
    }
  }

  return `${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}/${ano} às ${DIVULGACAO_HORA_INICIO}h`;
}

function primeiroNome(nome) {
  const primeiro = String(nome || "").trim().split(/\s+/)[0];
  return primeiro || "jovem";
}

function montarMensagemDivulgacao(nome) {
  const servicos = DIVULGACAO_SERVICOS.join("\n");

  // Duas aberturas alternadas para as mensagens não ficarem todas idênticas.
  const aberturas = [
    `Olá, ${primeiroNome(nome)}! Tudo certo? 🎶\n\nAqui é o LabStudio do CRJ Flexal. Passando para lembrar que o estúdio continua de portas abertas para você!`,
    `E aí, ${primeiroNome(nome)}! 🎶\n\nO LabStudio do CRJ Flexal está com horários disponíveis e a gente quer te ver produzindo de novo!`
  ];
  const abertura = aberturas[Math.floor(Math.random() * aberturas.length)];

  return `${abertura}

Aqui você pode contar com:
${servicos}

Tudo 100% gratuito: o LabStudio faz parte do CRJ, um programa público voltado para as juventudes.

📍 Escolha seu horário:
${PUBLIC_SITE_URL}/

Se não quiser mais receber estes lembretes, responda SAIR.`;
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intervaloAleatorioDivulgacao() {
  return DIVULGACAO_INTERVALO_MIN_MS + Math.floor(Math.random() * (DIVULGACAO_INTERVALO_MAX_MS - DIVULGACAO_INTERVALO_MIN_MS));
}

async function marcarUsuarioComoJaUsouEstudio(usuarioId) {
  if (!usuarioId) return;

  const { error } = await supabase
    .from("usuarios")
    .update({ ja_usou_estudio: true })
    .eq("id", usuarioId)
    .eq("ja_usou_estudio", false);

  if (error) {
    throw error;
  }
}

async function buscarDestinatariosDivulgacao() {
  const { data, error } = await supabase
    .from("usuarios")
    .select("id, nome, telefone, status")
    .eq("ja_usou_estudio", true)
    .eq("aceita_divulgacao", true)
    .order("id", { ascending: true });

  if (error) {
    throw error;
  }

  return (data || []).filter((usuario) =>
    String(usuario.status || "ativo").toLowerCase() !== "bloqueado" &&
    limparTelefone(usuario.telefone)
  );
}

async function buscarEnviosDoCiclo(ciclo) {
  const { data, error } = await supabase
    .from("divulgacao_envios")
    .select("usuario_id, status")
    .eq("ciclo", ciclo);

  if (error) {
    throw error;
  }

  return data || [];
}

// Reserva o envio ANTES de mandar a mensagem: se não der para gravar, não envia.
// Assim uma falha no banco nunca faz a mesma pessoa receber duas vezes.
async function reservarEnvioDivulgacao(usuarioId, ciclo) {
  const { error } = await supabase
    .from("divulgacao_envios")
    .insert([{ usuario_id: usuarioId, ciclo, status: "erro", erro: "envio em andamento" }]);

  if (error) {
    throw error;
  }
}

async function concluirEnvioDivulgacao({ usuarioId, ciclo, status, erro = null }) {
  const { error } = await supabase
    .from("divulgacao_envios")
    .update({ status, erro, enviado_em: new Date().toISOString() })
    .eq("usuario_id", usuarioId)
    .eq("ciclo", ciclo);

  if (error) {
    console.error("❌ Não consegui atualizar o registro da divulgação:", error.message);
  }

  if (status === "enviado") {
    await supabase
      .from("usuarios")
      .update({ ultima_divulgacao_em: new Date().toISOString() })
      .eq("id", usuarioId);
  }
}

// Libera a reserva quando a falha foi do navegador do bot, para tentar de novo na próxima verificação.
async function liberarReservaDivulgacao(usuarioId, ciclo) {
  await supabase
    .from("divulgacao_envios")
    .delete()
    .eq("usuario_id", usuarioId)
    .eq("ciclo", ciclo);
}

// Falhas do Chrome/WhatsApp Web (não do número da pessoa): a mensagem não saiu e vale tentar depois.
function erroTemporarioDoNavegador(erro) {
  return /detached Frame|Session closed|Target closed|Protocol error|Execution context was destroyed/i.test(String(erro && erro.message || erro));
}

async function executarCicloDivulgacao() {
  if (!DIVULGACAO_ATIVA || divulgacaoEmAndamento || !botPronto) return;

  // Logo após conectar, o WhatsApp Web ainda recarrega a página; espera estabilizar.
  if (!botProntoDesde || Date.now() - botProntoDesde < DIVULGACAO_ESPERA_APOS_CONECTAR_MS) return;

  const ciclo = obterCicloDivulgacaoAtual();
  if (!ciclo) return;

  divulgacaoEmAndamento = true;

  try {
    const destinatarios = await buscarDestinatariosDivulgacao();
    const jaProcessados = new Set((await buscarEnviosDoCiclo(ciclo)).map((envio) => envio.usuario_id));
    const pendentes = destinatarios.filter((usuario) => !jaProcessados.has(usuario.id));

    if (!pendentes.length) return;

    console.log(`📣 Divulgação do ciclo ${ciclo}: ${pendentes.length} envio(s) pendente(s).`);

    for (const usuario of pendentes) {
      // Interrompe se o WhatsApp cair ou a janela de horário acabar; o restante sai na próxima verificação.
      if (!botPronto || obterCicloDivulgacaoAtual() !== ciclo) {
        console.log(`⏸️ Divulgação do ciclo ${ciclo} pausada; continua na próxima janela.`);
        return;
      }

      // Se a reserva falhar, o erro interrompe o ciclo sem enviar nada.
      await reservarEnvioDivulgacao(usuario.id, ciclo);

      try {
        const destino = await resolverDestinoWhatsApp(usuario.telefone);
        await client.sendMessage(destino, montarMensagemDivulgacao(usuario.nome));
        await concluirEnvioDivulgacao({ usuarioId: usuario.id, ciclo, status: "enviado" });
        console.log(`✅ Divulgação enviada para ${mascararNumeroWhatsApp(destino)}.`);
      } catch (envioError) {
        const erro = String(envioError.message || envioError).slice(0, 300);

        if (erroTemporarioDoNavegador(envioError)) {
          await liberarReservaDivulgacao(usuario.id, ciclo);
          console.warn(`⏸️ WhatsApp Web instável (${erro}); divulgação continua na próxima verificação.`);
          return;
        }

        await concluirEnvioDivulgacao({ usuarioId: usuario.id, ciclo, status: "erro", erro });
        console.warn(`⚠️ Falha na divulgação para ${mascararNumeroWhatsApp(usuario.telefone)}:`, erro);
      }

      await esperar(intervaloAleatorioDivulgacao());
    }

    console.log(`🏁 Divulgação do ciclo ${ciclo} concluída.`);
  } catch (err) {
    console.error("❌ Erro na divulgação quinzenal:", err.message || err);
  } finally {
    divulgacaoEmAndamento = false;
  }
}

// Verifica a cada 5 minutos se há envio pendente; não envia nada fora do dia/horário.
setInterval(executarCicloDivulgacao, 5 * 60 * 1000).unref();

function mensagemPedeSairDaDivulgacao(mensagemNormalizada) {
  return ["sair", "parar", "pare"].includes(mensagemNormalizada);
}

async function processarPedidoSairDivulgacao(msg) {
  const { usuario, error } = await buscarUsuarioPorWhatsApp(msg);

  if (error || !usuario) return;

  const { data: atualizados, error: erroAtualizacao } = await supabase
    .from("usuarios")
    .update({ aceita_divulgacao: false })
    .eq("id", usuario.id)
    .eq("aceita_divulgacao", true)
    .select("id");

  if (erroAtualizacao) {
    console.error("❌ Não consegui registrar o pedido de SAIR da divulgação:", erroAtualizacao.message);
    return;
  }

  // Só confirma para quem estava recebendo, para não responder qualquer "sair" de conversa comum.
  if (!atualizados || !atualizados.length) return;

  await client.sendMessage(
    msg.from,
    `Pronto, ${primeiroNome(usuario.nome)}! Você não vai mais receber os lembretes do LabStudio.

O agendamento continua normal: é só mandar "agendar" quando quiser gravar. 🎙️`
  );

  console.log(`🔕 Divulgação desativada a pedido de ${mascararNumeroWhatsApp(msg.from)}.`);
}

// ===============================
// ROTAS ADMIN DA DIVULGAÇÃO
// ===============================
const limitarTesteDivulgacao = limitarRequisicoes({
  janelaMs: 10 * 60 * 1000,
  maximo: 5,
  nome: "teste-divulgacao"
});

app.get("/api/divulgacao/resumo", exigirAdminSupabase, async (req, res) => {
  try {
    const destinatarios = await buscarDestinatariosDivulgacao();
    const agora = obterAgoraSaoPaulo();
    const ultimoDiaCiclo = [...DIVULGACAO_DIAS].reverse().find((dia) => agora.dia >= dia) || DIVULGACAO_DIAS[0];
    const ultimoCiclo = `${agora.ano}-${String(agora.mes).padStart(2, "0")}-${String(ultimoDiaCiclo).padStart(2, "0")}`;
    const envios = await buscarEnviosDoCiclo(ultimoCiclo);

    return res.json({
      ok: true,
      ativa: DIVULGACAO_ATIVA,
      botPronto,
      emAndamento: divulgacaoEmAndamento,
      totalDestinatarios: destinatarios.length,
      proximoEnvio: obterProximoEnvioDivulgacao(agora),
      ultimoCiclo,
      enviadosUltimoCiclo: envios.filter((envio) => envio.status === "enviado").length,
      errosUltimoCiclo: envios.filter((envio) => envio.status === "erro").length,
      exemploMensagem: montarMensagemDivulgacao("Fulano")
    });
  } catch (err) {
    return responderErroApi(res, 500, "Não consegui carregar a divulgação. Confira se o SQL supabase/divulgacao.sql foi executado.", err);
  }
});

app.post("/api/divulgacao/teste", limitarTesteDivulgacao, exigirAdminSupabase, async (req, res) => {
  try {
    const destino = normalizarNumeroWhatsApp(BOT_NOTIFY_NUMBER);

    if (!destino) {
      return responderErroApi(res, 503, "BOT_NOTIFY_NUMBER não configurado no servidor.");
    }

    if (!botPronto) {
      return responderErroApi(res, 503, "WhatsApp ainda não está pronto para enviar mensagens.");
    }

    await client.sendMessage(destino, `🧪 TESTE DA DIVULGAÇÃO (só você recebeu)\n\n${montarMensagemDivulgacao("Fulano")}`);

    return res.json({ ok: true, destino: mascararNumeroWhatsApp(destino) });
  } catch (err) {
    return responderErroApi(res, 500, "Falha ao enviar o teste da divulgação.", err);
  }
});

// ===============================
// INICIALIZA O CLIENTE DO WHATSAPP
// ===============================
async function inicializarWhatsAppComRetry(tentativa = 1) {
  try {
    console.log(`🚀 Inicializando WhatsApp... tentativa ${tentativa}`);
    await client.initialize();
  } catch (err) {
    botPronto = false;
    console.error("❌ Falha ao inicializar WhatsApp:", err);

    // Handle stale browser session lock
    if (err.message && err.message.includes("The browser is already running")) {
      console.log("🔧 Detectado navegador em execução. Tentando limpar sessão bloqueada...");

      try {
        const fs = require("fs");
        const path = require("path");
        const { execSync } = require("child_process");
        const authPath = path.join(__dirname, WWEBJS_AUTH_PATH, `session-${WHATSAPP_CLIENT_ID}`);

        // Kill all Chrome processes aggressively
        try {
          console.log("🛑 Encerrando todos os processos Chrome...");
          execSync('taskkill /f /im chrome.exe /t', { stdio: 'ignore' });
          console.log("✅ Processos Chrome encerrados");
        } catch (killErr) {
          console.log("⚠️ Nenhum processo Chrome encontrado ou já encerrado");
        }

        // Wait for processes to fully terminate
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Try to remove lockfile multiple times with retries
        const lockfilePath = path.join(authPath, "lockfile");
        let retries = 3;
        while (retries > 0 && fs.existsSync(lockfilePath)) {
          try {
            fs.unlinkSync(lockfilePath);
            console.log("🧹 Lockfile removido com sucesso");
            break;
          } catch (lockErr) {
            console.log(`⏳ Tentando remover lockfile novamente... (${retries} tentativas restantes)`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            retries--;
          }
        }

        // If lockfile still exists, try to remove the entire session directory
        if (fs.existsSync(lockfilePath)) {
          console.log("🔄 Lockfile ainda bloqueado. Removendo diretório de sessão completo...");
          try {
            // Remove the entire session directory to force a clean start
            const sessionDir = path.join(__dirname, WWEBJS_AUTH_PATH);
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
              console.log("🗑️ Diretório de sessão removido completamente");
            }
          } catch (dirErr) {
            console.error("❌ Falha ao remover diretório de sessão:", dirErr);
          }
        }

        // Wait a moment for cleanup
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Try initialization again immediately after cleanup
        console.log("🔄 Tentando inicializar novamente após limpeza...");
        return inicializarWhatsAppComRetry(tentativa);
      } catch (cleanupErr) {
        console.error("❌ Falha geral na limpeza:", cleanupErr);
      }
    }

    if (tentativa < 5) {
      const espera = 10000 * tentativa;
      console.log(`⏳ Tentando novamente em ${espera / 1000}s...`);
      setTimeout(() => inicializarWhatsAppComRetry(tentativa + 1), espera);
    } else {
      console.error("❌ Limite de tentativas atingido. Reinicie o processo ou verifique o Chrome/Puppeteer.");
    }
  }
}

// Guard rail de deploy: registra o diagnostico antes de iniciar o WhatsApp para evitar falhas silenciosas.
registrarDiagnosticoBot();
inicializarWhatsAppComRetry();

// ===============================
// VIGIA DO NAVEGADOR
// O Chrome às vezes trava sozinho e o whatsapp-web.js fica esperando para sempre,
// sem erro. Se o navegador cair, ou se em 3 minutos o bot não ficar pronto nem
// mostrar QR, encerra o processo para o pm2 subir um novo do zero.
// ===============================
const INICIO_DO_PROCESSO = Date.now();
const LIMITE_INICIALIZACAO_MS = 3 * 60 * 1000;

setInterval(() => {
  const navegador = client.pupBrowser;
  const navegadorConectado = navegador
    ? (typeof navegador.isConnected === "function" ? navegador.isConnected() : navegador.connected)
    : true;

  if (!navegadorConectado) {
    console.error("💥 O Chrome do bot caiu. Reiniciando o processo para reconectar.");
    process.exit(1);
  }

  if (!botPronto && !qrAtualTexto && Date.now() - INICIO_DO_PROCESSO > LIMITE_INICIALIZACAO_MS) {
    console.error("💥 WhatsApp não ficou pronto nem gerou QR em 3 minutos. Reiniciando o processo.");
    process.exit(1);
  }
}, 15 * 1000).unref();

// ===============================
// INICIALIZA O SERVIDOR
// Em localhost, a porta vem do .env ou usa 3001 por padrão.
// ===============================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);

  const baseUrl = obterUrlBaseBot();
  // Logamos apenas o formato da URL; o token real fica fora do terminal.
  const qrPageUrl = `${baseUrl}/qr?token=SEU_TOKEN`;

  // Guard rail de deploy: mostra o Chrome efetivo sem exigir caminho customizado em VPS/local.
  console.log(`🧭 Chrome usado pelo Puppeteer: ${CHROME_EXECUTABLE_PATH || "padrão do ambiente/Puppeteer"}`);
  console.log(`💾 Sessão WhatsApp LocalAuth: ${WWEBJS_AUTH_PATH}`);
  console.log(`🌐 URL local do bot: ${baseUrl}`);
  console.log(`🔎 Status do bot: ${baseUrl}/status`);
  console.log(`📲 Página do QR: ${qrPageUrl}`);
});
