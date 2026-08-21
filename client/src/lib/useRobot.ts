// ============================================================================
//  Enlace com o servidor: um WebSocket, reconexão automática e o estado do
//  robô como dado React.
//
//  Duas cadências de propósito:
//   - `state`  (React, ~25 Hz)  -> painéis de texto, fases, lâmpadas
//   - `liveRef` (ref, sem render) -> a cena 3D lê no useFrame, a 60 fps,
//     interpolando entre quadros de rede sem forçar render de React nenhum.
// ============================================================================
import { useEffect, useRef, useState } from "react";
import type { ClientCmd, HelloMsg, RobotState, ServerMsg } from "../../../shared/types";

export interface RobotLink {
  state: RobotState | null;
  phases: string[];
  layout: HelloMsg["layout"];
  connected: boolean;
  liveRef: React.MutableRefObject<RobotState | null>;
  send: (cmd: ClientCmd) => void;
}

const LAYOUT_PADRAO: HelloMsg["layout"] = {
  pick: { r: 1150, top: 550 },
  pallet: { size: 1200, top: 150, r: 1150 },
  box: { w: 500, d: 150, h: 570 },
  pedestal: 400,
};

export function useRobot(): RobotLink {
  const [state, setState] = useState<RobotState | null>(null);
  const [phases, setPhases] = useState<string[]>([]);
  const [layout, setLayout] = useState(LAYOUT_PADRAO);
  const [connected, setConnected] = useState(false);
  const liveRef = useRef<RobotState | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout>;

    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerMsg;
        if (msg.type === "hello") {
          setPhases(msg.phases);
          setLayout(msg.layout);
        } else if (msg.type === "state") {
          liveRef.current = msg;
          setState(msg);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        // Perder o enlace NÃO congela a tela em silêncio: o estado fica, o
        // selo SEM COMUNICAÇÃO acende, e a reconexão insiste sozinha.
        if (alive) retry = setTimeout(connect, 1000);
      };
    }
    connect();

    return () => {
      alive = false;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const send = (cmd: ClientCmd) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
  };

  return { state, phases, layout, connected, liveRef, send };
}
