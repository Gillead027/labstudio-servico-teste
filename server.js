// ===============================
// IMPORTAÇÕES PRINCIPAIS
// ===============================
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { createClient } = require("@supabase/supabase-js");

// ===============================
// CONFIGURAÇÕES VIA VARIÁVEIS DE AMBIENTE
// Nunca coloque chaves, tokens ou números sensíveis direto no código.
// ===============================
const PORT = Number(process.env.PORT || 3001);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_NOTIFY_NUMBER = process.env.BOT_NOTIFY_NUMBER;
const PUBLIC_SITE_URL = String(process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(origem => origem.trim())
  .filter(Boolean);

const ORIGENS_PADRAO_DESENVOLVIMENTO = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`
];

const origensPermitidas = new Set([
  ...ORIGENS_PADRAO_DESENVOLVIMENTO,
  ...ALLOWED_ORIGINS,
  ...(PUBLIC_SITE_URL ? [PUBLIC_SITE_URL] : [])
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
exigirVariavelAmbiente("PUBLIC_SITE_URL", PUBLIC_SITE_URL);

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
    if (!origin || origensPermitidas.has(origin)) {
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
// LocalAuth salva a sessão do WhatsApp
// No Railway, usamos uma pasta persistente para não perder o login
// ===============================
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: process.env.WWEBJS_AUTH_PATH || ".wwebjs_auth"
  }),
  puppeteer: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: true
  }
});

// ===============================
// STATUS DO BOT
// Usamos isso para saber se o WhatsApp já está pronto
// ===============================
let botPronto = false;

// ===============================
// QR CODE PARA LOGIN NO WHATSAPP
// Só aparece se precisar conectar ou reconectar o WhatsApp
// ===============================
client.on("qr", (qr) => {
  console.log("\n📲 Escaneie o QR Code abaixo:\n");
  qrcode.generate(qr, { small: true });
});

// ===============================
// QUANDO O WHATSAPP ESTÁ PRONTO
// ===============================
client.on("ready", () => {
  botPronto = true;
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
function gerarVariantesTelefone(valor) {
  const numero = limparTelefone(valor);

  if (!numero) return [];

  const variantes = new Set();

  function adicionar(n) {
    if (!n) return;

    variantes.add(n);

    // Se tem 55, também testa sem 55
    if (n.startsWith("55")) {
      variantes.add(n.slice(2));
    } else {
      // Se não tem 55, também testa com 55
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

    // Número do contato quando disponível
    if (contato.number) {
      telefonesDetectados.push(contato.number);
    }

    // ID interno do WhatsApp quando disponível
    if (contato.id && contato.id.user) {
      telefonesDetectados.push(contato.id.user);
    }
  } catch (err) {
    console.log("⚠️ Não consegui pegar contato:", err.message);
  }

  // Fallback: pega o número direto do msg.from
  // Exemplo: 5527997136155@c.us vira 5527997136155
  if (msg.from) {
    telefonesDetectados.push(String(msg.from).split("@")[0]);
  }

  // Cria todas as variações possíveis do número da pessoa
  const variantesMensagem = [
    ...new Set(telefonesDetectados.flatMap(gerarVariantesTelefone))
  ];

  console.log("📱 Telefones detectados:", telefonesDetectados);
  console.log("🔎 Variantes para busca:", variantesMensagem);

  // Busca todos os usuários cadastrados
  // Fazemos assim para conseguir comparar mesmo que o telefone esteja salvo com máscara
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

  // Compara cada telefone do banco com as variações detectadas
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

    return res.json({
      ok: true,
      mensagem: "Cadastro enviado com sucesso! A equipe do CRJ irá analisar seus dados. Após aprovação, você poderá solicitar o agendamento pelo WhatsApp."
    });
  } catch (err) {
    return responderErroApi(res, 500, "Erro ao processar cadastro online.", err);
  }
});

// ===============================
// AUTOATENDIMENTO DO WHATSAPP
// Detecta palavras-chave e decide se envia o link
// ===============================
client.on("message", async (msg) => {
  try {
  // Ignora mensagens enviadas pelo próprio bot
  if (msg.fromMe) return;

  // Ignora mensagens vazias
  if (!msg.body) return;

  const mensagemRecebida = msg.body.toLowerCase();

  // Palavras que ativam o atendimento do LabStudio
  const gatilhos = [
    "estúdio",
    "stúdio",
    "studio",
    "labstudio",
    "labstúdio",
    "estudio",
    "gravar",
    "música"
  ];

  const encontrouGatilho = gatilhos.some((palavra) =>
    mensagemRecebida.includes(palavra)
  );

  // Se não encontrou gatilho, não faz nada
  if (!encontrouGatilho) return;

  console.log(`📩 Gatilho recebido de: ${msg.from}`);

  // Busca o usuário no Supabase antes de mandar o link
  const {
    usuario,
    telefonesDetectados,
    variantesMensagem,
    error
  } = await buscarUsuarioPorWhatsApp(msg);

  // Caso dê erro ao consultar Supabase
  if (error) {
    console.log("❌ Erro ao consultar cadastro:", error.message);

    await client.sendMessage(
      msg.from,
      "No momento não consegui consultar seu cadastro. Tente novamente mais tarde ou procure a equipe do CRJ."
    );

    return;
  }

  // Se não encontrar o usuário, envia o link para cadastro online
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

  // Normaliza status e faltas para evitar erro de comparação
  const statusUsuario = String(usuario.status || "").toLowerCase();
  const faltasUsuario = Number(usuario.faltas || 0);

  // Se estiver bloqueado ou tiver 2 faltas ou mais
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

  // Se o cadastro online existe, mas ainda não foi aprovado pela equipe
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
  // Mantida exatamente no formato que você pediu
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
// ROTA DE TESTE
// Serve para abrir no navegador e ver se o bot está online
// Exemplo:
// http://localhost:3001
// ou link do ngrok
// ===============================

// ===============================
// ROTA /notificar
// O site chama essa rota quando alguém conclui o agendamento
// Aqui o bot envia a notificação para seu número B
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

  // Mensagem que chega no seu WhatsApp pessoal/trabalho
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

  const destino = normalizarNumeroWhatsApp(telefone);

  if (!destino) {
    return res.status(400).json({ erro: "telefone_invalido" });
  }

  const mensagem = `Olá, ${nome || "jovem"}!

Seu cadastro no LabStudio CRJ FLEXAL foi aprovado pela equipe do CRJ.

Agora você já pode solicitar seu agendamento pelo link abaixo:
${PUBLIC_SITE_URL}/

Aguardamos você para realizar sua gravação! 🔥`;

  try {
    if (!botPronto) {
      console.log("⚠️ Bot ainda não está pronto para enviar aprovação.");
      return res.status(503).json({ erro: "bot_nao_pronto" });
    }

    await client.sendMessage(destino, mensagem);

    console.log(`✅ Aprovação enviada para ${nome || "usuário"} - ${telefone}`);
    res.json({ status: "enviado" });
  } catch (err) {
    console.error("❌ Erro ao enviar aprovação:", err);
    res.status(500).json({ erro: "falha_ao_enviar" });
  }
});

// ===============================
// INICIALIZA O CLIENTE DO WHATSAPP
// ===============================
client.initialize();

// ===============================
// INICIALIZA O SERVIDOR LOCAL
// A porta vem do .env. Por padrão, use PORT=3001.
// O ngrok precisa apontar para a mesma porta configurada.
// ===============================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
