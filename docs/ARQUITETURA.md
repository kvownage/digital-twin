# Arquitetura — supervisório com sinais reais

```
┌─────────────┐  Modbus TCP   ┌──────────────┐   MQTT    ┌─────────┐   MQTT   ┌──────────────┐   WebSocket   ┌────────────┐
│  CLP S7     │──────────────>│   GATEWAY    │──────────>│ BROKER  │─────────>│ SERVIDOR WEB │──────────────>│ NAVEGADOR  │
│ (TIA Portal)│  porta 502    │  (gateway/)  │  publica  │Mosquitto│ assina   │ (server/)    │  login Google │ REAL ⇄ SIM │
└─────────────┘               └──────────────┘           └─────────┘          └──────────────┘               └────────────┘
```

Princípio: o navegador **desenha o que chega** — ele não sabe se a fonte é o
CLP ou o simulador. A troca REAL/SIMULADOR acontece no servidor, e o simulador
continua vivo em segundo plano como reserva.

---

## 1. CLP — projeto `CLP_VENTILADOR_EMBALAGEM_V0_OEE` (TIA V17)

> Levantado do export VCI real, não suposto. Blocos relevantes:
> `06 - MODBUS CONN` (FC), `DB MODBUS COMM` (DB 34), `MODBUS COILS` (DB 36),
> `MODBUS HOLDINGS` (DB 37), `ESTADOS` (DB 14), `ALARMES` (DB 13).

### 1.1 O Modbus JÁ EXISTE — não criar nada

O CLP já é **servidor Modbus TCP**:

| O que | Onde |
|---|---|
| Instrução | `MB_SERVER` no FC `06 - MODBUS CONN`, instância `MB_SERVER_DB` |
| Conexão | `DB MODBUS COMM`.`Conection` (`TCON_IP_v4`) — **porta 502**, `InterfaceId` 64, ID 1 |
| Registradores | `MB_HOLD_REG` := `"MODBUS HOLDINGS".HOLDINGS` — `Array[0..99] of Word` |
| Coils | `MODBUS COILS`.`COILS` — `Array[0..99] of Bool` (nenhuma em uso) |

Mapeamento direto: **holding register N ↔ `HOLDINGS[N]`**.

### 1.2 O que já ocupa as HOLDINGS (integração da balança)

| HR | Uso atual | **Não mexer** |
|----|-----------|---------------|
| 0 | PEÇA EM POSIÇÃO | ✋ |
| 1 | PESO: 0 aguardando · 1 OK · 2 NOK | ✋ |
| 2 | LIFE BIT BALANÇA | ✋ |
| 3 | LIFE BIT CLP (bit 0) | ✋ |
| 4–9 | — | folga proposital para a balança crescer |
| **10–26** | **supervisório** (abaixo) | livre |
| 27–99 | livre | |

### 1.3 O mapa do supervisório — FC `07 - SUPERVISORIO`

Código pronto em **[`plc/07_SUPERVISORIO.scl`](../plc/07_SUPERVISORIO.scl)**:
criar o FC em SCL, colar, e chamar no fim do `Main [OB1]` depois do
`06 - MODBUS CONN`. O bloco **só lê** o processo e escreve no DB de Modbus —
não comanda nada.

| HR | Conteúdo | Origem no CLP |
|----|----------|---------------|
| 10 | estado do robô, 16 bits | `%I100.x`, `%I101.x`, `%I102.x`, `%Q102.5/6` |
| 11 | célula e segurança, 16 bits | sensores de palete/esteira, portas, barreiras, torre |
| 12 | passo INICIALIZAÇÃO ROBÔ | `"ESTADOS"."INICIALIZACAO ROBO"` |
| 13 | passo PALETIZAÇÃO LADO 1 | `"ESTADOS"."PALETIZACAO LAD. 01"` |
| 14 | passo PALETIZAÇÃO LADO 2 | `"ESTADOS"."PALETIZAÇAO LAD. 02"` |
| 15 | quantidade do **lado ativo** | `%IW103` ROBO - QTDE LADO 1 |
| 16 | place (posição na sequência) | `%IW109` RETORNO PLACE |
| 17 | camada (retorno) | `%IW111` RETORNO CAMADA |
| 18 | altura da caixa | `%IW113` |
| 19 | altura do pallet | `%IW115` |
| 20 | shift Y | `%IW105` |
| 21 | shift Z | `%IW107` |
| 22 | camada (comando) | `%QW113` |
| 23 | alarme robô | `"ALARMES"."ROBO EM FALHA"` |
| 24 | alarme balança | `"ALARMES"."BALANCA"` |
| 25 | pressão de ar × 100 | `%MD100` PRESSAO AR (Real → Int) |
| 26 | **heartbeat** (+1 por ciclo) | o próprio HR26 |

Bits de **HR10 — robô**: 0 EM RUN · 1 SERVO ON · 2 EM MASTER JOB · 3 EM FALHA ·
4 EM REMOTO · 5 EM HOME · 6 FORA DE HOME · 7 PEGA OK · 8 LADO 1 ATIVO ·
9 LADO 2 ATIVO · 10 CAIXA EM INDEXADOR · 11 LIGA VÁCUO GARRA · 12 VÁCUO OK ·
13 DESCARGA CHEIA · 14 FIM ENCAIX. LADO 1 · 15 FIM ENCAIX. LADO 2

Bits de **HR11 — célula**: 0 SP3 ESTEIRA ENTRADA · 1 INDEXADOR AVANÇADO ·
2 SP1 PEÇA ROBÔ · 3 PRESENÇA PALETE 1 · 4 PRESENÇA PALETE 2 · 5 SP4 PALETE 01 ·
6 SP5 PALETE 02 · 7 ESTEIRA ENTRADA LIGADA · 8 ESTEIRA SAÍDA LIGADA ·
9 SELADORA DESABILITADA · 10 HABILITA AUTOMÁTICO · 11 PORTA 01 · 12 PORTA 02 ·
13 BARREIRA 01 · 14 BARREIRA 02 · 15 TORRE VERMELHA

### 1.4 Lacunas conhecidas (honestidade sobre o que ainda não dá)

- **Um contador serve aos dois paletes.** Apesar do nome, `ROBO - QTDE LADO 1`
  é a contagem do lado **ativo**: a célula termina um palete e começa o outro,
  nunca alterna. Os bits LADO 1/2 ATIVO da HR10 dizem de quem é a contagem.
  Não é lacuna — é como a máquina opera. (Confirmado no `03 - LOGICAS SAIDAS`
  e pelo autor do programa.)
- **As juntas do robô não chegam ao CLP.** A troca S7↔YRC1000 é por sinais
  discretos + shift X/Y/Z; não há ângulo de eixo. Em modo REAL o braço 3D fica
  em repouso e o resto da tela é verdade. Para animar de fato, o caminho é ler
  o YRC1000 direto (High-Speed Ethernet Server, UDP 10040) — ver
  `server/yaskawa-hses.ts`.
- **A balança dá veredito, não valor.** HR1 é 0/1/2, não quilos. O peso em
  número exige mais uma holding do lado da balança.

### 1.5 Teste sem gateway

Com o FC 07 carregado, qualquer cliente Modbus deve devolver as 27 words:

```bash
modpoll -m tcp -a 1 -r 1 -c 27 IP_DO_CLP
```

HR26 tem de **mudar a cada leitura** — é o heartbeat. Se estiver parado, o
programa não está rodando (ou o FC não foi chamado no OB1).

---

## 2. Gateway Modbus → MQTT (`gateway/`)

Processo Node pequeno e sem estado: lê as 11 words a cada 100 ms, converte
para JSON e publica no broker. Roda na mesma máquina do CLP ou em qualquer
ponto da rede industrial.

```bash
cd gateway
cp .env.example .env      # IP do CLP, URL do broker
npm run gateway
```

Publica em `multilaser/paletizadora/r01/estado` (retained), no máximo 10 Hz e
só quando algo muda. O campo `plcOk` cai para `false` se o heartbeat do CLP
congelar por 2 s — sinal Modbus vivo com programa parado NÃO passa por dado
bom.

## 3. Broker MQTT

Qualquer um serve. Sugestão de partida: **Mosquitto** num container da própria
rede:

```bash
docker run -d --name mqtt -p 1883:1883 eclipse-mosquitto
```

Para produção com o supervisório na internet: broker com TLS e usuário/senha
(EMQX, HiveMQ Cloud, ou Mosquitto atrás de VPN). O gateway e o servidor web
recebem a URL via variável de ambiente.

## 4. Servidor web (`server/`)

- **Duas fontes, uma interface**: `Gp12Simulator` e `MqttSource` emitem o
  mesmo `RobotState`. O seletor REAL/SIMULADOR escolhe qual vai para os
  navegadores; o simulador segue vivo em segundo plano como reserva.
- **Modo REAL**: contadores, peso, fase e juntas vêm do broker. A PILHA é
  derivada dos contadores usando as mesmas tabelas do padrão (`slot()`) — o
  CLP não precisa transmitir posição de caixa nenhuma.
- **Frescor**: sem mensagem nova no broker por 2 s → selo `SEM DADOS REAIS`
  no topo e o estado congela explícito (não finge que está vivo).
- **Login Google** restrito ao domínio (seção 5).

## 5. Login com conta Google (domínio Multilaser)

1. [console.cloud.google.com](https://console.cloud.google.com) → APIs &
   Services → Credentials → **Create OAuth client ID** (Web application).
2. Authorized redirect URI: `https://SEU_HOST/auth/callback` (em
   desenvolvimento: `http://localhost:3001/auth/callback`).
3. Copiar Client ID e Secret para o `.env` do servidor:

```env
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
AUTH_DOMINIO=grupomultilaser.com.br
SESSION_SECRET=um-segredo-longo-aleatorio
BASE_URL=https://supervisorio.exemplo.com
```

O servidor valida o `id_token` no endpoint da própria Google e aceita apenas
contas com `hd`/e-mail do domínio configurado. **Sem as variáveis, o login
fica desativado** (modo desenvolvimento) e o servidor avisa no console.

O WebSocket também é protegido: a sessão do cookie é verificada no upgrade.

## 6. Falha e fallback

| Cenário | Comportamento |
|---|---|
| Broker fora do ar | selo `SEM DADOS REAIS`; operador troca para SIMULADOR com um clique |
| CLP parado (heartbeat congelado) | gateway publica `plcOk:false`; mesmo selo |
| Gateway morto | mensagens retained envelhecem; o frescor de 2 s detecta |
| Voltar dados | selo verde `DADOS REAIS`; troca para REAL com um clique |

A troca é **manual por decisão**: fallback automático esconderia do operador
que a fonte real caiu.

## 7. Publicação na web

O servidor é um processo Node único (`npm run build && npm start`). Para
expor na internet: reverse proxy com HTTPS (Caddy/nginx/Cloudflare Tunnel) na
frente da porta 3001 — o OAuth do Google exige HTTPS fora de localhost.
