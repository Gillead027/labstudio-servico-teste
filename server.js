const express = require("express");
const cors = require("cors");
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

// 🔥 Configuração do Bot para ambiente de nuvem (Render)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        // Atualizei o caminho com a versão exata que apareceu no seu LOG (127.0.6533.88)
        executablePath: '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process',
            '--no-zygote'
        ],
        headless: true
    }
});

client.on('qr', (qr) => {
    // Esse QR vai aparecer nos LOGS do Render!
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ NOVO MOTOR CONECTADO COM SUCESSO!');
});

client.on('message', async (msg) => {
    const mensagemRecebida = msg.body.toLowerCase();
    const gatilhos = ['estúdio', 'labstudio', 'labstúdio', 'estudio', 'gravar', 'música'];
    const encontrouGatilho = gatilhos.some(palavra => mensagemRecebida.includes(palavra));

    if (encontrouGatilho) {
        // ⚠️ ATENÇÃO: Troque 'SEU-SITE.vercel.app' pelo link que a Vercel te deu!
        const resposta = `Olá! Você está em contato com o atendimento automático do *LabStudio CRJ FLEXAL*. 🎙️

Para agendar sua sessão, acesse o link abaixo:
https://labstudio-sistema.vercel.app

*Orientações:*
1. Selecione a data e o horário.
2. Compareça no horário agendado.

Aguardamos você! 🔥`;

        await client.sendMessage(msg.from, resposta);
    }
});

client.initialize();

app.post("/notificar", async (req, res) => {
    const { nome, data, horario } = req.body;
    const mensagem = `🚀 NOVO AGENDAMENTO\n\nNome: ${nome}\nData: ${data}\nHorário: ${horario}`;
    const numeroB = "5527996509068@c.us"; 

    try {
        await client.sendMessage(numeroB, mensagem);
        res.json({ status: "enviado" });
    } catch (err) {
        res.status(500).json({ erro: "falha ao enviar" });
    }
});

// 🔥 O Render define a porta automaticamente, por isso usamos process.env.PORT
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
