// ===============================
// IMPORTAÇÕES PRINCIPAIS
// ===============================
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
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
const PUBLIC_SITE_URL = String(process.env.PUBLIC_SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// URL base do bot. Em testes locais, deixe vazio para usar localhost.
// Exemplo:
// PUBLIC_BOT_URL=http://localhost:3001
const PUBLIC_BOT_URL = String(process.env.PUBLIC_BOT_URL || "").replace(/\/$/, "");

// Token para proteger a página do QR Code.
// Defina no .env local:
// QR_PAGE_TOKEN=uma_senha_forte
const QR_PAGE_TOKEN = process.env.QR_PAGE_TOKEN;
const CHROME_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const WWEBJS_AUTH_PATH = process.env.WWEBJS_AUTH_PATH || ".wwebjs_auth";

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

exigirVariavelAmbiente("SUPABASE_URL", SUPABASE_URL);
exigirVariavelAmbiente("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
exigirVariavelAmbiente("BOT_NOTIFY_NUMBER", BOT_NOTIFY_NUMBER);

// QR_PAGE_TOKEN não derruba o servidor, mas a rota /qr fica bloqueada se ele não existir.
if (!QR_PAGE_TOKEN) {
  console.warn("⚠️ QR_PAGE_TOKEN não configurado. A página /qr ficará bloqueada por segurança.");
}

// ===============================
// CONFIGURAÇÃO DO SERVIDOR EXPRESS
// Esse servidor recebe requisições do site
// Exemplo: POST /notificar
// ===============================
const app = express();

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

app.use(express.json());

// ===============================
// SERVIR ARQUIVOS DO SITE LOCALMENTE
// Isso permite abrir index.html e admin.html pelo próprio servidor.
// ===============================
app.use(express.static(__dirname));

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
// CONFIGURAÇÃO DO CLIENTE WHATSAPP
// LocalAuth salva a sessão do WhatsApp.
// Em localhost, a sessão fica em .wwebjs_auth por padrão.
// ===============================
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "bot-crj",
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

  if (tokenRecebido !== QR_PAGE_TOKEN) {
    res.status(403).send(`
      <html>
        <head>
          <meta charset="UTF-8" />
          <title>Acesso negado</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 32px;">
          <h2>Acesso negado</h2>
          <p>Token inválido ou ausente.</p>
        </body>
      </html>
    `);

    return false;
  }

  return true;
}

// ===============================
// ROTA: PÁGINA DO QR CODE
// Acesse assim:
// http://localhost:3001/qr?token=SEU_TOKEN
// ===============================
app.get("/qr", (req, res) => {
  if (!verificarTokenQr(req, res)) return;

  const baseUrl = obterUrlBaseBot(req);
  const token = encodeURIComponent(QR_PAGE_TOKEN);
  const qrImagemUrl = `${baseUrl}/qr.png?token=${token}&t=${Date.now()}`;
  const status = botPronto ? "conectado" : qrAtualTexto ? "aguardando_qr" : "iniciando";

  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>QR Code WhatsApp - LabStudio</title>

        <style>
          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            min-height: 100vh;
            font-family: Arial, sans-serif;
            background: #111827;
            color: #f9fafb;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
          }

          .card {
            width: 100%;
            max-width: 460px;
            background: #1f2937;
            border: 1px solid #374151;
            border-radius: 18px;
            padding: 28px;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
          }

          h1 {
            font-size: 24px;
            margin: 0 0 8px;
          }

          p {
            color: #d1d5db;
            line-height: 1.5;
          }

          .status {
            display: inline-block;
            margin: 12px 0 20px;
            padding: 8px 12px;
            border-radius: 999px;
            font-size: 14px;
            background: #374151;
          }

          .qr-box {
            background: #ffffff;
            padding: 16px;
            border-radius: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin: 12px 0;
          }

          .qr-box img {
            width: 300px;
            max-width: 100%;
            height: auto;
            display: block;
          }

          .success {
            background: #064e3b;
            color: #d1fae5;
            border: 1px solid #065f46;
            border-radius: 12px;
            padding: 16px;
            margin-top: 18px;
          }

          .warning {
            background: #78350f;
            color: #fffbeb;
            border: 1px solid #92400e;
            border-radius: 12px;
            padding: 16px;
            margin-top: 18px;
          }

          .small {
            font-size: 13px;
            color: #9ca3af;
            margin-top: 18px;
          }

          .button {
            display: inline-block;
            margin-top: 16px;
            padding: 10px 16px;
            border-radius: 10px;
            background: #2563eb;
            color: white;
            text-decoration: none;
            font-weight: bold;
          }

          code {
            background: #111827;
            border: 1px solid #374151;
            border-radius: 8px;
            padding: 2px 6px;
          }
        </style>
      </head>

      <body>
        <main class="card">
          <h1>QR Code WhatsApp</h1>
          <p>Use o WhatsApp no celular para escanear e conectar o bot do LabStudio.</p>

          <div class="status">
            Status: <strong>${status}</strong>
          </div>

          ${
            botPronto
              ? `
                <div class="success">
                  <strong>✅ WhatsApp conectado.</strong>
                  <p>O bot já está pronto para enviar e receber mensagens.</p>
                </div>
              `
              : qrAtualTexto
                ? `
                  <div class="qr-box">
                    <img src="${qrImagemUrl}" alt="QR Code WhatsApp" />
                  </div>

                  <p class="small">
                    QR gerado em: ${qrGeradoEm ? new Date(qrGeradoEm).toLocaleString("pt-BR") : "não informado"}
                  </p>

                  <a class="button" href="${baseUrl}/qr?token=${token}">
                    Atualizar QR
                  </a>

                  <p class="small">
                    Se o QR expirar, aguarde alguns segundos e atualize esta página.
                  </p>
                `
                : `
                  <div class="warning">
                    <strong>⏳ Nenhum QR disponível ainda.</strong>
                    <p>O bot ainda está iniciando ou tentando restaurar uma sessão salva.</p>
                    <p>Atualize a página em alguns segundos.</p>
                  </div>

                  <a class="button" href="${baseUrl}/qr?token=${token}">
                    Atualizar página
                  </a>
                `
          }
        </main>
      </body>
    </html>
  `);
});

// ===============================
// ROTA: IMAGEM PNG DO QR CODE
// Essa rota retorna uma imagem real do QR Code.
// A página /qr usa essa imagem.
// ===============================
app.get("/qr.png", async (req, res) => {
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
app.get("/pairing-code", async (req, res) => {
  if (!verificarTokenQr(req, res)) return;

  const phone = req.query.phone;

  if (!phone) {
    return res.status(400).send(`
      <html>
        <head>
          <meta charset="UTF-8" />
          <title>Telefone obrigatorio</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 32px;">
          <h2>Telefone obrigatorio</h2>
          <p>Informe o telefone na URL usando o parametro <strong>phone</strong>.</p>
          <p>Exemplo: <code>/pairing-code?token=SEU_TOKEN&amp;phone=5527999999999</code></p>
        </body>
      </html>
    `);
  }

  const phoneNumber = limparTelefone(phone);

  if (!phoneNumber) {
    return res.status(400).send(`
      <html>
        <head>
          <meta charset="UTF-8" />
          <title>Telefone invalido</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 32px;">
          <h2>Telefone invalido</h2>
          <p>Informe um telefone com numeros, incluindo DDI e DDD.</p>
          <p>Exemplo: <code>5527999999999</code></p>
        </body>
      </html>
    `);
  }

  try {
    const code = await client.requestPairingCode(phoneNumber);

    codigoPareamentoAtual = code;
    codigoPareamentoGeradoEm = new Date().toISOString();

    console.log("🔐 Código de pareamento gerado:", code);

    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Codigo de Pareamento WhatsApp - LabStudio</title>

          <style>
            * {
              box-sizing: border-box;
            }

            body {
              margin: 0;
              min-height: 100vh;
              font-family: Arial, sans-serif;
              background: #111827;
              color: #f9fafb;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 24px;
            }

            .card {
              width: 100%;
              max-width: 520px;
              background: #1f2937;
              border: 1px solid #374151;
              border-radius: 18px;
              padding: 28px;
              text-align: center;
              box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
            }

            h1 {
              font-size: 24px;
              margin: 0 0 8px;
            }

            p {
              color: #d1d5db;
              line-height: 1.5;
            }

            .code {
              margin: 24px 0;
              padding: 22px;
              border-radius: 16px;
              background: #ffffff;
              color: #111827;
              font-size: 42px;
              line-height: 1;
              font-weight: 800;
              letter-spacing: 4px;
              word-break: break-word;
            }

            .instructions {
              text-align: left;
              background: #111827;
              border: 1px solid #374151;
              border-radius: 12px;
              padding: 16px 18px;
              margin-top: 18px;
            }

            .instructions ol {
              margin: 0;
              padding-left: 22px;
              color: #d1d5db;
              line-height: 1.6;
            }

            .small {
              font-size: 13px;
              color: #9ca3af;
              margin-top: 18px;
            }

            code {
              background: #111827;
              border: 1px solid #374151;
              border-radius: 8px;
              color: #f9fafb;
              padding: 2px 6px;
            }
          </style>
        </head>

        <body>
          <main class="card">
            <h1>Codigo de Pareamento</h1>
            <p>Use este codigo no WhatsApp do celular do CRJ para vincular o bot do LabStudio.</p>

            <div class="code">${code}</div>

            <div class="instructions">
              <ol>
                <li>Abra o WhatsApp no celular.</li>
                <li>Va em <strong>Aparelhos conectados</strong>.</li>
                <li>Toque em <strong>Conectar aparelho</strong>.</li>
                <li>Escolha a opcao para conectar com numero de telefone e informe o codigo acima.</li>
              </ol>
            </div>

            <p class="small">Telefone: <code>${phoneNumber}</code></p>
            <p class="small">Gerado em: ${new Date(codigoPareamentoGeradoEm).toLocaleString("pt-BR")}</p>
          </main>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Erro ao gerar código de pareamento:", err);
    res.status(500).send("Erro ao gerar codigo de pareamento.");
  }
});

// ===============================
// ROTA: CODIGO DE PAREAMENTO EM JSON
// ===============================
app.get("/pairing-code.json", async (req, res) => {
  if (!verificarTokenQr(req, res)) return;

  const phone = req.query.phone;

  if (!phone) {
    return res.status(400).json({
      ok: false,
      erro: "Informe o parametro phone."
    });
  }

  const phoneNumber = limparTelefone(phone);

  if (!phoneNumber) {
    return res.status(400).json({
      ok: false,
      erro: "Telefone invalido."
    });
  }

  try {
    const code = await client.requestPairingCode(phoneNumber);

    codigoPareamentoAtual = code;
    codigoPareamentoGeradoEm = new Date().toISOString();

    console.log("🔐 Código de pareamento gerado:", code);

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
    const token = QR_PAGE_TOKEN ? encodeURIComponent(QR_PAGE_TOKEN) : "CONFIGURE_QR_PAGE_TOKEN";
    const qrPageUrl = `${baseUrl}/qr?token=${token}`;
    const qrImageUrl = `${baseUrl}/qr.png?token=${token}`;

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
client.on("ready", () => {
  botPronto = true;

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

// ===============================
// FUNÇÃO: NORMALIZAR NÚMERO DO WHATSAPP
// Aceita número puro ou número já terminado em @c.us.
// ===============================
function normalizarNumeroWhatsApp(telefone) {
  const valorOriginal = String(telefone || "").trim();
  const semSufixo = valorOriginal.replace(/@c\.us$/i, "");
  const numero = limparTelefone(semSufixo);

  if (!numero) return "";

  // Mantém compatibilidade com números locais digitados sem o código do Brasil.
  const numeroComPais = numero.startsWith("55") ? numero : "55" + numero;

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

    candidatos.add(numero.startsWith("55") ? numero : `55${numero}`);
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

    // Se tem 55, também testa sem 55.
    if (n.startsWith("55")) {
      variantes.add(n.slice(2));
    } else {
      // Se não tem 55, também testa com 55.
      variantes.add("55" + n);
    }
  }

  adicionar(numero);

  const sem55 = numero.startsWith("55") ? numero.slice(2) : numero;

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
// O CRJ atende jovens de 15 a 29 anos.
// ===============================
function idadePermitida(dataNascimento) {
  const idade = calcularIdade(dataNascimento);
  return idade !== null && idade >= 15 && idade <= 29;
}

// ===============================
// FUNÇÃO: VALIDAR DATA DE AGENDAMENTO
// Garante no servidor as mesmas regras de terça/quinta e datas bloqueadas.
// ===============================
function validarDataAgendamento(dataSelecionada) {
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

  const diaSemana = dataObjeto.getDay();

  if (![2, 4].includes(diaSemana)) {
    return {
      ok: false,
      mensagem: "O LabStudio funciona apenas às terças e quintas-feiras."
    };
  }

  if (DATAS_BLOQUEADAS.includes(dataSelecionada)) {
    return {
      ok: false,
      mensagem: "Esta data está reservada para evento interno ou feriado."
    };
  }

  return { ok: true };
}

// ===============================
// FUNÇÃO: BUSCAR USUÁRIO POR TELEFONE
// Usa a service role no servidor para comparar variações com/sem 55 e nono dígito.
// ===============================
async function buscarUsuarioPorTelefone(telefone) {
  const variantesDigitadas = gerarVariantesTelefone(telefone);

  if (variantesDigitadas.length === 0) {
    return {
      usuario: null,
      variantesDigitadas
    };
  }

  const { data: usuarios, error } = await supabase
    .from("usuarios")
    .select("*");

  if (error) {
    console.error("❌ Falha ao consultar usuários no Supabase:", error.message);
    throw error;
  }

  const usuarioEncontrado = (usuarios || []).find((usuario) => {
    const variantesBanco = gerarVariantesTelefone(usuario.telefone);

    return variantesBanco.some((numeroBanco) =>
      variantesDigitadas.includes(numeroBanco)
    );
  });

  return {
    usuario: usuarioEncontrado || null,
    variantesDigitadas
  };
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
// FUNÇÃO: BUSCAR USUÁRIO PELO WHATSAPP
// Essa função:
// 1. pega o número de quem mandou mensagem;
// 2. gera variações desse número;
// 3. consulta todos os usuários no Supabase;
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

  console.log("📱 Telefones detectados:", telefonesDetectados);
  console.log("🔎 Variantes para busca:", variantesMensagem);

  // Busca todos os usuários cadastrados.
  // Fazemos assim para conseguir comparar mesmo que o telefone esteja salvo com máscara.
  const { data: usuarios, error } = await supabase
    .from("usuarios")
    .select("*");

  if (error) {
    console.error("❌ Falha ao consultar usuários no Supabase:", error.message);

    return {
      usuario: null,
      telefonesDetectados,
      variantesMensagem,
      error
    };
  }

  // Compara cada telefone do banco com as variações detectadas.
  const usuarioEncontrado = (usuarios || []).find((usuario) => {
    const variantesBanco = gerarVariantesTelefone(usuario.telefone);

    return variantesBanco.some((numeroBanco) =>
      variantesMensagem.includes(numeroBanco)
    );
  });

  if (usuarioEncontrado) {
    console.log(
      "✅ Usuário encontrado:",
      usuarioEncontrado.nome,
      usuarioEncontrado.telefone
    );
  } else {
    console.log("❌ Nenhum usuário encontrado para esse número.");
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
app.get("/api/horarios", async (req, res) => {
  const dataSelecionada = String(req.query.data || "").trim();
  const validacaoData = validarDataAgendamento(dataSelecionada);

  if (!validacaoData.ok) {
    return responderErroApi(res, 400, validacaoData.mensagem);
  }

  try {
    const ocupados = await buscarHorariosOcupados(dataSelecionada);
    const horariosDisponiveis = HORARIOS_TERCA_QUINTA.filter((hora) =>
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
app.post("/api/agendar", async (req, res) => {
  const nome = String(req.body.nome || "").trim();
  const telefoneLimpo = limparTelefone(req.body.telefone);
  const dataSelecionada = String(req.body.data || "").trim();
  const horario = String(req.body.horario || "").trim();

  if (!nome || !telefoneLimpo || !dataSelecionada || !horario) {
    return responderErroApi(res, 400, "Preencha todos os campos corretamente.");
  }

  const validacaoData = validarDataAgendamento(dataSelecionada);

  if (!validacaoData.ok) {
    return responderErroApi(res, 400, validacaoData.mensagem);
  }

  if (!HORARIOS_TERCA_QUINTA.includes(horario)) {
    return responderErroApi(res, 400, "Horário inválido para esta agenda.");
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

    if (!idadePermitida(usuario.data_nascimento)) {
      return responderErroApi(
        res,
        403,
        "O LabStudio atende jovens de 15 a 29 anos. Procure a equipe do CRJ."
      );
    }

    const statusUsuario = String(usuario.status || "").toLowerCase();
    const faltasUsuario = Number(usuario.faltas || 0);

    if (statusUsuario === "bloqueado" || faltasUsuario >= 2) {
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

    const ocupados = await buscarHorariosOcupados(dataSelecionada);

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
      return responderErroApi(res, 500, "Erro ao salvar agendamento.", error);
    }

    return res.json({
      ok: true,
      mensagem: `Confirmado, ${nome}! 🔥\nTe esperamos dia ${dataSelecionada} às ${horario}.`,
      agendamento: agendamentoCriado
    });
  } catch (err) {
    return responderErroApi(res, 500, "Erro ao processar agendamento.", err);
  }
});

// ===============================
// API PÚBLICA: CADASTRO ONLINE
// Salva solicitações públicas como pendentes usando service role somente no servidor.
// ===============================
app.post("/api/cadastro-online", async (req, res) => {
  const nome = String(req.body.nome || "").trim();
  const telefoneLimpo = limparTelefone(req.body.telefone);
  const dataNascimento = String(req.body.data_nascimento || req.body.dataNascimento || "").trim();

  if (!nome || !telefoneLimpo || !dataNascimento) {
    return responderErroApi(
      res,
      400,
      "Preencha nome completo, WhatsApp e data de nascimento."
    );
  }

  if (!idadePermitida(dataNascimento)) {
    return responderErroApi(res, 400, "O CRJ atende jovens de 15 a 29 anos.");
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
client.on("message", async (msg) => {
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

    const mensagemRecebida = msg.body.toLowerCase();
    const mensagemNormalizada = mensagemRecebida
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const saudacoesSimples = new Set([
      "oi",
      "ola",
      "olá",
      "bom dia",
      "boa tarde",
      "boa noite",
      "eai",
      "e ai",
      "opa"
    ]);

    if (saudacoesSimples.has(mensagemNormalizada)) return;

    // Palavras que ativam o atendimento do LabStudio.
    const gatilhos = [
      "estúdio",
      "stúdio",
      "studio",
      "labstudio",
      "labstúdio",
      "estudio",
      "gravar",
      "música",
      "agendar",
      "agendamento",
      "agenda",
      "horario",
      "horário",
      "marcar",
      "reservar",
      "reserva"
    ];

    const encontrouGatilho = gatilhos.some((palavra) =>
      mensagemRecebida.includes(palavra)
    );

    // Se não encontrou gatilho, não faz nada.
    if (!encontrouGatilho) return;

    console.log(`📩 Gatilho recebido de: ${msg.from}`);

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

      await client.sendMessage(
        msg.from,
        "No momento não consegui consultar seu cadastro. Tente novamente mais tarde ou procure a equipe do CRJ."
      );

      return;
    }

    // Se não encontrar o usuário, envia o link para cadastro online.
    if (!usuario) {
      await client.sendMessage(
        msg.from,
        `Olá! Para agendar o LabStudio CRJ FLEXAL, é necessário estar cadastrado no CRJ.

Identificamos que este número ainda não consta em nosso cadastro.

Você pode realizar seu cadastro online pelo link abaixo:
${PUBLIC_SITE_URL}/cadastro.html

Após o envio, aguarde a análise da equipe do CRJ.`
      );

      console.log("❌ Usuário não cadastrado.");
      console.log("📱 Telefones detectados:", telefonesDetectados);
      console.log("🔎 Variantes testadas:", variantesMensagem);

      return;
    }

    // Normaliza status e faltas para evitar erro de comparação.
    const statusUsuario = String(usuario.status || "").toLowerCase();
    const faltasUsuario = Number(usuario.faltas || 0);

    // Se estiver bloqueado ou tiver 2 faltas ou mais.
    if (statusUsuario === "bloqueado" || faltasUsuario >= 2) {
      await client.sendMessage(
        msg.from,
        `Olá, ${usuario.nome || "jovem"}.

No momento, seu acesso ao agendamento do LabStudio está bloqueado por faltas anteriores.

📍 Procure presencialmente a equipe do CRJ para regularizar sua situação.`
      );

      console.log(`🚫 Usuário bloqueado: ${usuario.nome} - ${usuario.telefone}`);

      return;
    }

    // Se o cadastro online existe, mas ainda não foi aprovado pela equipe.
    if (statusUsuario === "pendente" || usuario.cadastrado === false) {
      await client.sendMessage(
        msg.from,
        "Seu cadastro online foi recebido e está aguardando análise da equipe do CRJ. Assim que for aprovado, você poderá solicitar o agendamento pelo WhatsApp."
      );

      console.log(`⏳ Usuário pendente de aprovação: ${usuario.nome} - ${usuario.telefone}`);

      return;
    }

    // ===============================
    // VERIFICAR DATA DE NASCIMENTO E IDADE
    // Bloqueia antes de enviar o link quando o cadastro está incompleto.
    // ===============================
    if (!usuario.data_nascimento) {
      await client.sendMessage(
        msg.from,
        `Olá, ${usuario.nome || "jovem"}.

Seu cadastro precisa ser atualizado com a data de nascimento antes de acessar o agendamento do LabStudio.

📍 Procure presencialmente a equipe do CRJ para atualizar seu cadastro.`
      );

      console.log(`⚠️ Usuário sem data de nascimento: ${usuario.nome} - ${usuario.telefone}`);

      return;
    }

    if (!idadePermitida(usuario.data_nascimento)) {
      await client.sendMessage(
        msg.from,
        `Olá, ${usuario.nome || "jovem"}.

O LabStudio atende jovens de 15 a 29 anos.

📍 Procure presencialmente a equipe do CRJ para mais orientações.`
      );

      console.log(`🚫 Usuário fora da faixa etária: ${usuario.nome} - ${usuario.telefone}`);

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

    await client.sendMessage(msg.from, resposta);

    console.log(
      `✅ Auto-resposta enviada para usuário cadastrado: ${usuario.nome} - ${usuario.telefone}`
    );
  } catch (err) {
    console.error("❌ Erro inesperado ao processar mensagem do WhatsApp:", err);

    try {
      if (msg && msg.from) {
        await client.sendMessage(
          msg.from,
          "No momento tive um problema ao processar sua mensagem. Tente novamente mais tarde ou procure a equipe do CRJ."
        );
      }
    } catch (sendError) {
      console.error("❌ Falha ao enviar mensagem de erro pelo WhatsApp:", sendError);
    }
  }
});

// ===============================
// ROTA /notificar
// O site chama essa rota quando alguém conclui o agendamento.
// Aqui o bot envia a notificação para seu número B.
// ===============================
app.post("/notificar", async (req, res) => {
  const { nome, telefone, data, horario } = req.body;
  const numeroB = normalizarNumeroWhatsApp(BOT_NOTIFY_NUMBER);

  console.log(
    `📥 Novo agendamento recebido: ${nome} - ${telefone} - ${data} às ${horario}`
  );

  console.log(`📥 /notificar recebeu dados: nome=${nome || "sem nome"}, data=${data || "sem data"}, horario=${horario || "sem horário"}`);
  console.log(`📲 Destino de notificação configurado: ${mascararNumeroWhatsApp(numeroB)}`);

  if (!numeroB) {
    console.error("❌ BOT_NOTIFY_NUMBER ausente ou inválido no .env.");

    return res.status(500).json({
      status: "erro",
      erro: "numero_notificacao_invalido",
      mensagem: "BOT_NOTIFY_NUMBER ausente ou inválido no servidor."
    });
  }

  // Mensagem que chega no seu WhatsApp pessoal/trabalho.
  const mensagem = `🚀 NOVO AGENDAMENTO

Nome: ${nome}
Telefone: ${telefone}
Data: ${data}
Horário: ${horario}`;

  // Envia a mensagem para o número configurado no .env.
  try {
    if (!botPronto) {
      console.warn("⚠️ Bot ainda não está pronto para enviar notificação.");

      return res.status(503).json({
        status: "erro",
        erro: "bot_nao_pronto",
        mensagem: "WhatsApp ainda não está pronto para enviar mensagens."
      });
    }

    await client.sendMessage(numeroB, mensagem);

    console.log(`✅ Notificação enviada com sucesso para ${mascararNumeroWhatsApp(numeroB)}.`);

    res.json({
      status: "enviado",
      destino: mascararNumeroWhatsApp(numeroB)
    });
  } catch (err) {
    console.error("❌ Falha ao enviar notificação pelo WhatsApp:", err);

    res.status(500).json({
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
app.post("/notificar-aprovacao", async (req, res) => {
  const { nome, telefone } = req.body;
  console.log(`📨 /notificar-aprovacao recebeu: nome=${nome || "sem nome"}, telefone=${mascararNumeroWhatsApp(telefone)}`);

  const telefoneLimpo = limparTelefone(telefone);

  if (!telefoneLimpo) {
    console.warn("⚠️ /notificar-aprovacao sem telefone válido.");

    return res.status(400).json({
      erro: "telefone_invalido",
      mensagem: "Telefone inválido ou ausente para enviar a aprovação."
    });
  }

  const mensagem = `Olá, ${nome || "jovem"}!

Seu cadastro no LabStudio CRJ FLEXAL foi aprovado pela equipe do CRJ.

Agora você já pode solicitar seu agendamento pelo link abaixo:
${PUBLIC_SITE_URL}/

Aguardamos você para realizar sua gravação! 🔥`;

  try {
    if (!botPronto) {
      console.log("⚠️ Bot ainda não está pronto para enviar aprovação.");
      return res.status(503).json({
        erro: "bot_nao_pronto",
        mensagem: "WhatsApp ainda não está pronto para enviar aprovação."
      });
    }

    const destino = await resolverDestinoWhatsApp(telefoneLimpo);

    if (!destino) {
      console.warn(`⚠️ Não foi possível resolver destino WhatsApp para ${mascararNumeroWhatsApp(telefoneLimpo)}.`);

      return res.status(400).json({
        erro: "telefone_whatsapp_nao_encontrado",
        mensagem: "Não encontrei esse telefone como WhatsApp válido para enviar a aprovação."
      });
    }

    await client.sendMessage(destino, mensagem);

    console.log(`✅ Aprovação enviada para ${nome || "usuário"} - ${mascararNumeroWhatsApp(destino)}`);
    res.json({
      status: "enviado",
      destino: mascararNumeroWhatsApp(destino)
    });
  } catch (err) {
    console.error("❌ Erro ao enviar aprovação:", err);
    res.status(500).json({
      erro: "falha_ao_enviar",
      mensagem: err.message || "Falha desconhecida ao enviar aprovação pelo WhatsApp."
    });
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

    if (tentativa < 5) {
      const espera = 10000 * tentativa;
      console.log(`⏳ Tentando novamente em ${espera / 1000}s...`);
      setTimeout(() => inicializarWhatsAppComRetry(tentativa + 1), espera);
    } else {
      console.error("❌ Limite de tentativas atingido. Reinicie o processo ou verifique o Chrome/Puppeteer.");
    }
  }
}

inicializarWhatsAppComRetry();

// ===============================
// INICIALIZA O SERVIDOR
// Em localhost, a porta vem do .env ou usa 3001 por padrão.
// ===============================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);

  const baseUrl = obterUrlBaseBot();
  const token = QR_PAGE_TOKEN ? encodeURIComponent(QR_PAGE_TOKEN) : "CONFIGURE_QR_PAGE_TOKEN";
  const qrPageUrl = `${baseUrl}/qr?token=${token}`;

  console.log(`🧭 Chrome usado pelo Puppeteer: ${CHROME_EXECUTABLE_PATH}`);
  console.log(`💾 Sessão WhatsApp LocalAuth: ${WWEBJS_AUTH_PATH}`);
  console.log(`🌐 URL local do bot: ${baseUrl}`);
  console.log(`🔎 Status do bot: ${baseUrl}/status`);
  console.log(`📲 Página do QR: ${qrPageUrl}`);
});
