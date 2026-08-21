# Supervisório GP12

> **Arquitetura com sinais reais** (CLP S7 → Modbus → gateway → MQTT →
> servidor → navegador, com login Google do domínio e seletor REAL/SIMULADOR):
> ver **[docs/ARQUITETURA.md](docs/ARQUITETURA.md)** — inclui o mapa Modbus e
> o roteiro do TIA Portal. O gateway roda com `npm run gateway`.

Supervisório web 3D do Motoman GP12: o robô pega a peça na mesa da frente,
gira 180° na base e solta na mesa de trás — visto de qualquer navegador da
rede, com câmera livre.

## Stack

| Camada | Tecnologia |
|---|---|
| Servidor | Node.js + Express + ws (WebSocket) |
| Fonte de dados | `server/simulator.ts` (PTP sincronizado, 50 Hz) — trocável pelo robô real |
| Cliente | React 18 + TypeScript + Vite |
| 3D | three.js via react-three-fiber + drei |

A simulação roda **no servidor**: todos os navegadores conectados veem o
mesmo robô e os comandos (pausar, ritmo) valem para todos — como num
supervisório de verdade.

## Rodar

```bash
npm install
npm run dev        # servidor (3001) + Vite (5173), abra http://localhost:5173
```

Produção:

```bash
npm run build      # gera client/dist
npm start          # Node serve tudo em http://localhost:3001
```

## Estrutura

```
server/
  index.ts          HTTP + WebSocket; retransmite o estado a 25 Hz
  simulator.ts      cinemática do GP12 + sequência pega-giro-solta
  yaskawa-hses.ts   ESBOÇO do leitor do robô real (UDP 10040, YRC1000)
shared/
  types.ts          contrato das mensagens servidor <-> navegador
client/
  src/App.tsx       layout e enlace
  src/lib/useRobot.ts   WebSocket + reconexão + estado
  src/scene/Robot.tsx   hierarquia de juntas (S -> L -> U -> punho)
  src/scene/Cell.tsx    chão, luzes, mesas, peça, câmera
  src/ui/Panel.tsx      juntas, TCP, sequência, controles
```

## Ligar no robô real

O YRC1000 publica posição via **High-Speed Ethernet Server** (UDP 10040,
habilitado de fábrica). Implementar `YaskawaHses` (ver o roteiro comentado em
`server/yaskawa-hses.ts`) e, no `server/index.ts`, trocar:

```ts
const sim = new Gp12Simulator();
// por:
const sim = new YaskawaHses("192.168.x.x");
```

O cliente não muda uma linha: ele desenha o que chegar.

## Dimensões e limites usados

Do desenho cotado do flyer Yaskawa do GP12: ombro a 450 mm com offset de
155 mm, braço inferior 614 mm, elevação do cotovelo 200 mm, antebraço 640 mm,
alcance R1440; velocidades de junta S 260°/s, L 230°/s, U 260°/s.
