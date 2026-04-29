FROM ghcr.io/puppeteer/puppeteer:22.6.0

USER root

# Instala dependências necessárias para o Chrome no Linux
RUN apt-get update && apt-get install -y \
    libnss3 \
    libdbus-1-3 \
    libatk1.0-0 \
    libasound2 \
    libxcasn1-3 \
    libxss1 \
    libgtk-3-0 \
    libgbm1 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Expõe a porta que o seu servidor usa
EXPOSE 3001

CMD ["node", "server.js"]
