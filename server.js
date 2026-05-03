// ===============================
// IMPORTAÇÕES PRINCIPAIS
// ===============================
const express = require("express");
const cors = require("cors");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { createClient } = require("@supabase/supabase-js");

// ===============================
// CONFIGURAÇÃO DO SERVIDOR EXPRESS
// Esse servidor recebe requisições do site
// Exemplo: POST /notificar
// ===============================
const app = express();

app.use(cors());
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
// Aqui o bot consegue consultar a tabela "usuarios"
// ===============================
const supabase = createClient(
  "https://hblxvxgocemzctjbutgi.supabase.co",
  "sb_publishable_12C1Wu47s3SuxqHZvQybdg_WubBGiQl"
);

// ===============================
// CONFIGURAÇÃO DO CLIENTE WHATSAPP
// LocalAuth salva a sessão do WhatsApp no seu PC
// Assim você não precisa escanear QR toda hora
// ===============================
const client = new Client({
  authStrategy: new LocalAuth(),
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
// FUNÇÃO: FORMATAR DESTINO DO WHATSAPP
// Garante o formato usado pelo whatsapp-web.js.
// ===============================
function formatarDestinoWhatsApp(telefone) {
  const numero = limparTelefone(telefone);

  if (!numero) return "";

  const numeroComPais = numero.startsWith("55") ? numero : "55" + numero;

  return `${numeroComPais}@c.us`;
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
// AUTOATENDIMENTO DO WHATSAPP
// Detecta palavras-chave e decide se envia o link
// ===============================
client.on("message", async (msg) => {
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
https://labstudio-sistema.vercel.app/cadastro.html

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
https://labstudio-sistema.vercel.app/

Orientações importantes:
1. Selecione a data e o horário desejados.
2. Certifique-se de comparecer no horário agendado para evitar atrasos nos demais atendimentos.
3. Caso precise cancelar, entre em contato com antecedência.

Aguardamos você para realizar sua gravação! 🔥`;

  await client.sendMessage(msg.from, resposta);

  console.log(
    `✅ Auto-resposta enviada para usuário cadastrado: ${usuario.nome} - ${usuario.telefone}`
  );
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

  console.log(
    `📥 Novo agendamento recebido: ${nome} - ${telefone} - ${data} às ${horario}`
  );

  // Mensagem que chega no seu WhatsApp pessoal/trabalho
  const mensagem = `🚀 NOVO AGENDAMENTO

Nome: ${nome}
Telefone: ${telefone}
Data: ${data}
Horário: ${horario}`;

  // Número B que vai receber os avisos
  const numeroB = "5527996509068@c.us";

  try {
    if (!botPronto) {
      console.log("⚠️ Bot ainda não está pronto para enviar mensagem.");
      return res.status(503).json({ erro: "bot_nao_pronto" });
    }

    await client.sendMessage(numeroB, mensagem);

    console.log("✅ Mensagem enviada para o seu celular!");
    res.json({ status: "enviado" });
  } catch (err) {
    console.error("❌ Erro ao enviar:", err);
    res.status(500).json({ erro: "falha_ao_enviar" });
  }
});

// ===============================
// ROTA /notificar-aprovacao
// Envia para o jovem a confirmação de cadastro aprovado e o link de agendamento.
// ===============================
app.post("/notificar-aprovacao", async (req, res) => {
  const { nome, telefone } = req.body;

  const destino = formatarDestinoWhatsApp(telefone);

  if (!destino) {
    return res.status(400).json({ erro: "telefone_invalido" });
  }

  const mensagem = `Olá, ${nome || "jovem"}!

Seu cadastro no LabStudio CRJ FLEXAL foi aprovado pela equipe do CRJ.

Agora você já pode solicitar seu agendamento pelo link abaixo:
https://labstudio-sistema.vercel.app/

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
// Porta 3001
// O ngrok precisa apontar para essa porta:
// ngrok http 3001
// ===============================
app.listen(3001, () => {
  console.log("🚀 Servidor rodando na porta 3001");
});
