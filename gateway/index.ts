// ============================================================================
//  GATEWAY: CLP S7-1500 (Modbus TCP) -> broker MQTT.
//
//  O CLP JÁ É servidor Modbus no projeto (FC "06 - MODBUS CONN", MB_SERVER,
//  porta 502, DB 37 "MODBUS HOLDINGS"). Este gateway só LÊ — ele nunca
//  escreve no CLP.
//
//  Lê HR0..HR26 a cada 100 ms, decodifica e publica no broker. Sem estado
//  próprio: morrer e renascer não perde nada.
//
//  Configuração via .env nesta pasta:
//    PLC_IP=192.168.0.10       MQTT_URL=mqtt://localhost:1883
//    PLC_PORT=502              MQTT_TOPICO=multilaser/paletizadora/r01/estado
//    PLC_UNIT=1
// ============================================================================
import "dotenv/config";
import ModbusRTU from "modbus-serial";
import mqtt from "mqtt";
import type { RealPayload } from "../shared/types.js";

const PLC_IP = process.env.PLC_IP ?? "192.168.0.10";
const PLC_PORT = Number(process.env.PLC_PORT ?? 502);
const PLC_UNIT = Number(process.env.PLC_UNIT ?? 1);
const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const TOPICO = process.env.MQTT_TOPICO ?? "multilaser/paletizadora/r01/estado";

const POLL_MS = 100;
const QTD_REG = 27;                  // HR0..HR26
const HEARTBEAT_TIMEOUT_MS = 2000;

// Int16 chega como UInt16 do modbus-serial — devolve o sinal.
const int16 = (v: number) => (v > 0x7fff ? v - 0x10000 : v);
const bit = (w: number, n: number) => (w & (1 << n)) !== 0;

const modbus = new ModbusRTU();
const broker = mqtt.connect(MQTT_URL);

broker.on("connect", () => console.log(`[gateway] broker OK: ${MQTT_URL}`));
broker.on("error", (e) => console.error(`[gateway] broker: ${e.message}`));

let conectado = false;
let ultimoHb = -1;
let ultimoHbTs = 0;
let ultimoJson = "";

async function conecta() {
  try {
    await modbus.connectTCP(PLC_IP, { port: PLC_PORT });
    modbus.setID(PLC_UNIT);
    modbus.setTimeout(500);
    conectado = true;
    console.log(`[gateway] CLP OK: ${PLC_IP}:${PLC_PORT}`);
  } catch (e) {
    conectado = false;
    console.error(`[gateway] CLP indisponível (${(e as Error).message}) — nova tentativa em 3 s`);
    setTimeout(conecta, 3000);
  }
}

async function le() {
  if (!conectado) return;
  try {
    const { data } = await modbus.readHoldingRegisters(0, QTD_REG);

    const st1 = data[10];
    const st2 = data[11];
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
        pecaNoRobo: bit(st2, 2), palete1: bit(st2, 3), palete2: bit(st2, 4),
        palete1b: bit(st2, 5), palete2b: bit(st2, 6),
        esteiraEntrada: bit(st2, 7), esteiraSaida: bit(st2, 8),
        seladoraDesabilitada: bit(st2, 9), automatico: bit(st2, 10),
        porta1: bit(st2, 11), porta2: bit(st2, 12),
        barreira1: bit(st2, 13), barreira2: bit(st2, 14),
        torreVermelha: bit(st2, 15),
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

      almRobo: int16(data[23]),
      almBalanca: int16(data[24]),
      pressaoBar: int16(data[25]) / 100,

      balanca: {
        pecaEmPosicao: data[0] !== 0,
        peso: (pesoBruto === 1 ? 1 : pesoBruto === 2 ? 2 : 0),
        lifeBit: bit(data[3], 0),
      },
    };

    // publica só quando muda (o ts fica de fora da comparação)
    const { ts: _ts, ...semTs } = payload;
    const json = JSON.stringify(semTs);
    if (json !== ultimoJson) {
      ultimoJson = json;
      broker.publish(TOPICO, JSON.stringify(payload), { retain: true });
    }
  } catch (e) {
    console.error(`[gateway] leitura falhou: ${(e as Error).message}`);
    conectado = false;
    modbus.close(() => {});
    setTimeout(conecta, 3000);
  }
}

conecta();
setInterval(le, POLL_MS);
console.log(`[gateway] lendo HR0..HR${QTD_REG - 1}, publicando em ${TOPICO}`);
