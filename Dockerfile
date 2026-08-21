# ============================================================================
#  Supervisório GP12 — imagem de produção.
#
#  Um processo só: Node servindo o build do cliente + WebSocket + fonte MQTT.
#  A porta vem de PORT (padrão 3001). Variáveis esperadas em produção:
#
#    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   trava de domínio (obrigatórias)
#    AUTH_DOMINIO=grupomultilaser.com.br
#    SESSION_SECRET=<aleatório longo>
#    BASE_URL=https://<url-publica>
#    MQTT_URL / MQTT_TOPICO                    broker (para o modo REAL)
# ============================================================================
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3001

CMD ["npx", "tsx", "server/index.ts"]
