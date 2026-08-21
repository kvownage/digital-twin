// ============================================================================
//  ESBOÇO — leitor do robô REAL via High-Speed Ethernet Server (YRC1000).
//
//  Não está ligado a nada ainda: existe para marcar ONDE o robô real entra e
//  COMO. Quando o GP12 estiver na rede, esta classe substitui a Gp12Simulator
//  no server/index.ts — a interface é a mesma (emite "state").
//
//  O High-Speed Ethernet Server é UDP na porta 10040, habilitado por padrão
//  nos YRC1000 — não exige opção paga nem MotoPlus. O comando 0x72
//  (Read robot position) devolve a posição em pulsos ou cartesiano.
//
//  Referência: Yaskawa "High Speed Ethernet Server Function Manual"
//  (HW1483602). Validar contra o manual da SUA versão de firmware antes de
//  confiar nos offsets abaixo.
// ============================================================================
import { EventEmitter } from "node:events";
// import dgram from "node:dgram";

export class YaskawaHses extends EventEmitter {
  constructor(readonly ip: string, readonly port = 10040) {
    super();
    // Plano de implementação:
    //  1. socket UDP; montar o cabeçalho de 32 bytes "YERC" do protocolo
    //  2. a cada 40 ms, enviar Read Robot Position (comando 0x75 para pulso
    //     de junta / 0x72 cartesiano), instância 1
    //  3. converter pulso -> grau com a relação de pulso por junta do GP12
    //     (ler do parâmetro do controlador; NÃO copiar de outro modelo)
    //  4. emitir "state" no mesmo formato do simulador
    //  5. timeout de 3 respostas perdidas -> emitir "offline" e a IHM mostra
    //     SEM COMUNICAÇÃO — perder o enlace não pode parecer robô parado
    throw new Error("YaskawaHses: ainda não implementado — use Gp12Simulator");
  }
}
