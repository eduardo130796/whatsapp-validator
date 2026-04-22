FROM node:18-alpine

WORKDIR /app

# Copia apenas dependências primeiro (cache)
COPY package*.json ./

RUN npm install --production

# Copia resto do código
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]