// ============================================================================
//  GATEWAY: CLP S7-1500 (Modbus TCP) -> broker MQTT.
//
//  O CLP JÁ É servidor Modbus no projeto (FC "06 - MODBUS CONN", MB_SERVER,
//  DB 37 "MODBUS HOLDINGS"). Este gateway só LÊ — nunca escreve no CLP.
//
//  DUAS PORTAS, DUAS INSTÂNCIAS: a 502 é da BALANÇA (que escreve HR1/HR2) e o
//  gateway usa a 503, com instância MB_SERVER própria. Compartilhar a 502
//  deixaria as instâncias intercambiáveis, e o gateway poderia ocupar as duas
//  vagas numa reconexão — derrubando a balança e parando a linha.
//
//  Lê HR0..HR34 a cada 100 ms, decodifica e publica no broker. Sem estado
//  próprio: morrer e renascer não perde nada.
//
//  Configuração via .env nesta pasta (ver .env.example):
//    PLC_IP    o IP do S7
//    PLC_PORT  503
//    MQTT_URL / MQTT_USER / MQTT_PASS / MQTT_TOPICO
// ============================================================================
import "dotenv/config";
import ModbusRTU from "modbus-serial";
import mqtt from "mqtt";
import type { RealPayload } from "../shared/types.js";

const PLC_IP = process.env.PLC_IP ?? "192.168.0.10";
// 503 e não 502: a 502 é da BALANÇA. Porta separada garante que o gateway
// nunca ocupe a vaga dela numa reconexão — se ocupasse, o life bit da balança
// congelaria e a linha pararia. Ver plc/07_SUPERVISORIO.scl.
const PLC_PORT = Number(process.env.PLC_PORT ?? 503);
const PLC_UNIT = Number(process.env.PLC_UNIT ?? 1);
const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const TOPICO = process.env.MQTT_TOPICO ?? "multilaser/paletizadora/r01/estado";

const POLL_MS = 100;
const QTD_REG = 35;                  // HR0..HR34 (o mapa completo da FC 07)
const HEARTBEAT_TIMEOUT_MS = 2000;
// SINAL DE VIDA. Publicar só quando muda economiza rede, mas cria um engano:
// célula parada com o CLP rodando não muda NADA, então o gateway ficava
// mudo — e o supervisório, que exige mensagem com menos de 2 s, anunciava
// "SEM DADOS REAIS" com todo o caminho funcionando. Silêncio não é falha.
// Uma publicação por segundo, mesmo sem novidade, faz o frescor significar o
// que ele deve significar: o gateway está vivo.
const VIDA_MS = 1000;

// Int16 chega como UInt16 do modbus-serial — devolve o sinal.
const int16 = (v: number) => (v > 0x7fff ? v - 0x10000 : v);
const bit = (w: number, n: number) => (w & (1 << n)) !== 0;
/** Primeiro bit ligado na faixa, como número 1..qtd. Zero se nenhum. */
const primeiroBit = (w: number, base: number, qtd: number) => {
  for (let i = 0; i < qtd; i++) if (bit(w, base + i)) return i + 1;
  return 0;
};

const modbus = new ModbusRTU();
const broker = mqtt.connect(MQTT_URL, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
});

broker.on("connect", () => console.log(`[gateway] broker OK: ${MQTT_URL}`));
broker.on("error", (e) => console.error(`[gateway] broker: ${e.message}`));

let conectado = false;
let ultimoHb = -1;
let ultimoHbTs = 0;
let ultimoJson = "";
let ultimoEnvio = 0;
let ultimoPayload: RealPayload | null = null;
let lendo = false;                   // uma leitura Modbus de cada vez

async function conecta() {
  try {
    await modbus.connectTCP(PLC_IP, { port: PLC_PORT });
    modbus.setID(PLC_UNIT);
    // 1,5 s, não 500 ms: são 35 holdings num S7 que também atende a balança
    // na 502, em rede de fábrica. Meio segundo é aperto suficiente para dar
    // timeout por congestionamento e derrubar a conexão sem haver falha
    // nenhuma — foi o que aconteceu.
    modbus.setTimeout(1500);
    conectado = true;
    console.log(`[gateway] CLP OK: ${PLC_IP}:${PLC_PORT}`);
  } catch (e) {
    conectado = false;
    console.error(`[gateway] CLP indisponível (${(e as Error).message}) — nova tentativa em 3 s`);
    setTimeout(conecta, 3000);
  }
}

async function le() {
  if (!conectado || lendo) return;
  // A trava importa: `le` é chamada a cada 100 ms sem esperar a anterior. Numa
  // leitura demorada, dezenas de requisições se empilhavam na MESMA conexão
  // Modbus, e o congestionamento que causou o primeiro timeout passava a
  // causar todos os seguintes. Uma leitura de cada vez.
  lendo = true;
  try {
    const { data } = await modbus.readHoldingRegisters(0, QTD_REG);

    const st1 = data[10];   // robô
    const st2 = data[11];   // célula e segurança
    const st4 = data[28];   // causas da emergência
    const st5 = data[29];   // mosaico e variante
    const st6 = data[30];   // torre, vácuos, condições
    const hb = data[26];
    const agora = Date.now();
    if (hb !== ultimoHb) {
      ultimoHb = hb;
      ultimoHbTs = agora;
    }

    const pesoBruto = int16(data[1]);

    const payload: RealPayload = {
      ts: agora,
      // Modbus responde igual com o CLP em STOP. O que prova vida é o
      // heartbeat do FC 07 andando.
      plcOk: agora - ultimoHbTs < HEARTBEAT_TIMEOUT_MS,

      robo: {
        run: bit(st1, 0), servoOn: bit(st1, 1), masterJob: bit(st1, 2),
        falha: bit(st1, 3), remoto: bit(st1, 4), home: bit(st1, 5),
        foraHome: bit(st1, 6), pegaOk: bit(st1, 7),
        lado1: bit(st1, 8), lado2: bit(st1, 9), caixaIndexador: bit(st1, 10),
        vacuoLigado: bit(st1, 11), vacuoOk: bit(st1, 12),
        descargaCheia: bit(st1, 13),
        fimEncaix1: bit(st1, 14), fimEncaix2: bit(st1, 15),
      },

      celula: {
        caixaNaEsteira: bit(st2, 0), indexadorAvancado: bit(st2, 1),
        pecaNoRobo: bit(st2, 2),
        // Presença de palete: SP4 (bit 3) e SP5 (bit 4). Bits 5/6 reservados.
        palete1: bit(st2, 3), palete2: bit(st2, 4),
        esteiraEntrada: bit(st2, 7), esteiraSaida: bit(st2, 8),
        seladoraDesabilitada: bit(st2, 9), automatico: bit(st2, 10),
        porta1: bit(st2, 11), porta2: bit(st2, 12),
        barreira1: bit(st2, 13), barreira2: bit(st2, 14),
        torreVermelha: bit(st2, 15),
        emergencia: bit(st2, 5), emergenciaBotao: bit(st2, 6),
      },

      passos: {
        inicializacao: int16(data[12]),
        lado1: int16(data[13]),
        lado2: int16(data[14]),
      },

      qtdeLado1: int16(data[15]),
      place: int16(data[16]),
      camadaRetorno: int16(data[17]),
      alturaCaixa: int16(data[18]),
      alturaPallet: int16(data[19]),
      shiftY: int16(data[20]),
      shiftZ: int16(data[21]),
      camadaComando: int16(data[22]),
      paletesProduzidos: int16(data[27]),

      almRobo: int16(data[23]),
      almBalanca: int16(data[24]),
      pressaoBar: int16(data[25]) / 100,

      balanca: {
        pecaEmPosicao: data[0] !== 0,
        peso: (pesoBruto === 1 ? 1 : pesoBruto === 2 ? 2 : 0),
        lifeBit: bit(data[3], 0),
      },

      causaEmergencia: {
        botoes: bit(st4, 0),
        chaveSeg1: bit(st4, 1), chaveSeg2: bit(st4, 2),
        barreira1: bit(st4, 3), barreira2: bit(st4, 4),
        botaoLado1: bit(st4, 5), botaoLado2: bit(st4, 6),
        chaveLado1: bit(st4, 7), chaveLado2: bit(st4, 8),
        resetSeguranca: bit(st4, 9),
        botaoPainel: bit(st4, 10),
        botaoPorta1: bit(st4, 11), botaoPorta2: bit(st4, 12),
        botaoRobo: bit(st4, 13),
      },

      mosaico: {
        // Bits 0..6 = mosaico 1..7. Devolve o número, não o bit — quem lê
        // quer saber "qual padrão", não "qual bit".
        paletizar: primeiroBit(st5, 0, 7),
        encaixotar: (() => { const n = primeiroBit(st5 >> 9, 0, 5); return n ? n + 2 : 0; })(),
        caixaPequena: bit(st5, 7),
        armarCx4: bit(st5, 8),
        encaixotando: bit(st5, 14),
      },

      torre: {
        vermelho: bit(st6, 0), amarelo: bit(st6, 1),
        verde: bit(st6, 2), buzzer: bit(st6, 3),
        vc1: bit(st6, 4), vc2: bit(st6, 5), vc3: bit(st6, 6),
        condicaoCiclo: bit(st6, 7),
        condicaoLado1: bit(st6, 8), condicaoLado2: bit(st6, 9),
        inatividade: bit(st6, 10),
        trocarGarra: bit(st6, 11), posicaoTrocaGarra: bit(st6, 12),
        rejeitarMaster: bit(st6, 13), devolverMaster: bit(st6, 14),
        ligaDesliga: bit(st6, 15),
      },

      statusRobo: int16(data[31]),
      statusLado1: int16(data[32]),
      statusLado2: int16(data[33]),
      autoManual: int16(data[34]),
    };

    // Publica quando MUDA, e de qualquer forma uma vez por segundo — este
    // segundo é o sinal de vida (ver VIDA_MS). O ts fica fora da comparação,
    // senão toda leitura pareceria diferente e a comparação não filtraria
    // nada.
    const { ts: _ts, ...semTs } = payload;
    const json = JSON.stringify(semTs);
    if (json !== ultimoJson || agora - ultimoEnvio >= VIDA_MS) {
      ultimoJson = json;
      ultimoEnvio = agora;
      broker.publish(TOPICO, JSON.stringify(payload), { retain: true });
    }
    ultimoPayload = payload;
  } catch (e) {
    console.error(`[gateway] leitura falhou: ${(e as Error).message}`);
    conectado = false;
    modbus.close(() => {});
    setTimeout(conecta, 3000);
  } finally {
    lendo = false;
  }
}

// ----------------------------------------------------------------------------
//  SEM CONTATO COM O CLP: dizer isso, em vez de calar
//
//  A publicação mora dentro da leitura bem-sucedida. Quando o Modbus dá
//  timeout, o gateway parava de publicar — e a última mensagem RETIDA no
//  broker continuava afirmando `plcOk: true` para sempre. Quem chegasse depois
//  lia uma mentira com cara de verdade.
//
//  Enquanto não há contato, republica-se o último retrato conhecido com
//  `plcOk: false` e hora nova. O supervisório mostra SEM DADOS REAIS pelo
//  motivo certo, e a retida passa a contar o que está acontecendo.
// ----------------------------------------------------------------------------
setInterval(() => {
  if (conectado || !ultimoPayload) return;   // nada a dizer que já não se disse
  broker.publish(
    TOPICO,
    JSON.stringify({ ...ultimoPayload, ts: Date.now(), plcOk: false }),
    { retain: true });
}, VIDA_MS);

conecta();
setInterval(le, POLL_MS);
console.log(`[gateway] lendo HR0..HR${QTD_REG - 1}, publicando em ${TOPICO}`);
