const express = require("express");
const cors = require("cors");
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(cors());
app.use(express.json());

// 🔥 Inicia o novo bot do WhatsApp
const client = new Client({
    authStrategy: new LocalAuth(), // Salva o login para não pedir QR toda hora
    puppeteer: {
        headless: false // Abre o Chrome para o WhatsApp não bloquear
    }
});

// 🔥 Gera o QR Code no terminal se precisar logar
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

// 🔥 Avisa quando estiver pronto
client.on('ready', () => {
    console.log('✅ NOVO MOTOR CONECTADO COM SUCESSO!');
});

// 🔥 AUTORESPONDER: Detecta palavras-chave e envia o link
client.on('message', async (msg) => {
    const mensagemRecebida = msg.body.toLowerCase();
    
    // Lista de palavras que ativam o link
    const gatilhos = ['estúdio', 'labstudio', 'labstúdio', 'estudio', 'gravar', 'música'];

    // Verifica se a mensagem contém algum dos gatilhos
    const encontrouGatilho = gatilhos.some(palavra => mensagemRecebida.includes(palavra));

    if (encontrouGatilho) {
        const resposta = `Olá! Você está em contato com o atendimento automático do *LabStudio CRJ FLEXAL*. 🎙️

Identificamos que você tem interesse em utilizar nossos serviços de estúdio. Para garantir a organização e o acesso de todos, nossos agendamentos são realizados exclusivamente através do nosso portal oficial.

📍 *Para agendar sua sessão, acesse o link abaixo:*
http://localhost:3000

*Orientações importantes:*
1. Selecione a data e o horário desejados.
2. Certifique-se de comparecer no horário agendado para evitar atrasos nos demais atendimentos.
3. Caso precise cancelar, entre em contato com antecedência.

Aguardamos você para realizar sua gravação! 🔥`;;

        await client.sendMessage(msg.from, resposta);
        console.log(`Auto-resposta enviada para: ${msg.from}`);
    }
});

client.initialize();

// 🔥 Rota para receber o agendamento do seu site
app.post("/notificar", async (req, res) => {
    const { nome, data, horario } = req.body;

    const mensagem = `🚀 NOVO AGENDAMENTO\n\nNome: ${nome}\nData: ${data}\nHorário: ${horario}`;

    // 🔥 COLOQUE SEU NÚMERO B AQUI (Tente primeiro com o 9 extra, se der erro tire o 9)
    const numeroB = "5527996509068@c.us"; 

    try {
        await client.sendMessage(numeroB, mensagem);
        console.log("Mensagem enviada para o seu celular!");
        res.json({ status: "enviado" });
    } catch (err) {
        console.error("Erro ao enviar:", err);
        res.status(500).json({ erro: "falha ao enviar" });
    }
});

app.listen(3001, () => {
    console.log("Servidor rodando na porta 3001");
});