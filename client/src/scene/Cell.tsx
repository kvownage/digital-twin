// ============================================================================
//  A célula de paletização: esteira de entrada à frente, um palete de cada
//  lado do robô, a pilha crescendo caixa a caixa. O Canvas inteiro mora aqui.
// ============================================================================
import { Canvas, useFrame } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import { useRef } from "react";
import * as THREE from "three";
import { Robot } from "./Robot";
import { CaixaVentilador } from "./CaixaVentilador";
import type { HelloMsg, PlacedBox, RobotState } from "../../../shared/types";

const rad = (d: number) => (d * Math.PI) / 180;

const PAPELAO = "#A97C4B";
const MADEIRA = "#7A5C36";

/** Palete de madeira: tampo + três longarinas. */
function Palete({ z, size, top }: { z: number; size: number; top: number }) {
  return (
    <group position={[0, 0, z]}>
      <mesh position={[0, top - 22, 0]} castShadow receiveShadow>
        <boxGeometry args={[size, 44, size]} />
        <meshStandardMaterial color={MADEIRA} roughness={0.9} />
      </mesh>
      {[-size / 2 + 60, 0, size / 2 - 60].map((x, i) => (
        <mesh key={i} position={[x, (top - 44) / 2, 0]} castShadow>
          <boxGeometry args={[90, top - 44, size]} />
          <meshStandardMaterial color="#63482A" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

/** Etiqueta "TOLEDO" — textura de canvas, gerada uma vez. */
let etiquetaToledo: THREE.CanvasTexture | null = null;
function toledoTex(): THREE.CanvasTexture {
  if (etiquetaToledo) return etiquetaToledo;
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 64;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#0A3B7C";
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = "#FFFFFF";
  g.textAlign = "center";
  g.font = "700 38px 'IBM Plex Sans', sans-serif";
  g.fillText("TOLEDO", 128, 45);
  etiquetaToledo = new THREE.CanvasTexture(cv);
  return etiquetaToledo;
}

/** A entrada: esteira de correia (um pouco maior que a caixa) alimentando a
 *  balança Toledo de roletes, onde a caixa para para a pesagem dinâmica. */
function Entrada({ r, top }: { r: number; top: number }) {
  const rolos = [-262, -187, -112, -37, 38, 113, 188, 263];
  return (
    <group>
      {/* ---- esteira de correia: fininha — a caixa passa de lombada (150).
              Estrutura clara e correia VERDE industrial, para ler na cena ---- */}
      <group position={[r + 655, 0, 0]}>
        <mesh position={[0, top - 35, 0]} castShadow receiveShadow>
          <boxGeometry args={[650, 70, 300]} />
          <meshStandardMaterial color="#5A6B7C" roughness={0.5} metalness={0.35} />
        </mesh>
        {/* a correia verde, por cima */}
        <mesh position={[0, top + 3, 0]}>
          <boxGeometry args={[640, 8, 250]} />
          <meshStandardMaterial color="#2F8B5B" roughness={0.75} />
        </mesh>
        {[[-280, -105], [-280, 105], [280, -105], [280, 105]].map(([x, z], i) => (
          <mesh key={i} position={[x, (top - 70) / 2, z]} castShadow>
            <boxGeometry args={[50, top - 70, 50]} />
            <meshStandardMaterial color="#39434E" roughness={0.6} />
          </mesh>
        ))}
      </group>

      {/* ---- balança Toledo de roletes ---- */}
      <group position={[r, 0, 0]}>
        {/* corpo da balança (a célula de carga mora aqui) */}
        <mesh position={[0, top - 95, 0]} castShadow receiveShadow>
          <boxGeometry args={[600, 130, 460]} />
          <meshStandardMaterial color="#26313D" roughness={0.55} metalness={0.35} />
        </mesh>
        {/* etiqueta da marca, na frente */}
        <mesh position={[0, top - 95, 234]}>
          <planeGeometry args={[240, 60]} />
          <meshStandardMaterial map={toledoTex()} roughness={0.6} />
        </mesh>
        {/* os roletes — a superfície de pesagem */}
        {rolos.map((x, i) => (
          <mesh key={i} position={[x, top - 26, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[26, 26, 420, 20]} />
            <meshStandardMaterial color="#7E8B98" roughness={0.35} metalness={0.6} />
          </mesh>
        ))}
        {/* pés */}
        {[[-260, -190], [-260, 190], [260, -190], [260, 190]].map(([x, z], i) => (
          <mesh key={i} position={[x, (top - 160) / 2, z]} castShadow>
            <boxGeometry args={[50, top - 160, 50]} />
            <meshStandardMaterial color="#141B24" roughness={0.7} />
          </mesh>
        ))}
      </group>

      {/* ---- seladora de caixas (a OKB do snapshot) ---- */}
      <Seladora x={r + 1730} top={top} />
    </group>
  );
}

/** A seladora de caixas do snapshot (OKB): mesa de roletes cinza sobre pés
 *  com rodízios, correias laterais VERMELHAS que arrastam a caixa, e o
 *  pórtico com o cabeçote de fita em cima. Paramétrica, não malha do CAD —
 *  evoca a máquina sem carregar 26 MB de STEP. */
function Seladora({ x, top }: { x: number; top: number }) {
  const CINZA = "#3A4550";
  const FERRO = "#232C35";
  const VERMELHO = "#B3282D";
  const comp = 1500;
  const rolosSel: number[] = [];
  for (let rx = -650; rx <= 650; rx += 130) rolosSel.push(rx);

  return (
    // x é o CENTRO da mesa — o chamador posiciona a entrada da seladora
    // encostada no fim da esteira.
    <group position={[x, 0, 0]}>
      {/* mesa: quadro + roletes */}
      <mesh position={[0, top - 60, 0]} castShadow receiveShadow>
        <boxGeometry args={[comp, 55, 480]} />
        <meshStandardMaterial color={CINZA} roughness={0.55} metalness={0.35} />
      </mesh>
      {rolosSel.map((rx, i) => (
        <mesh key={i} position={[rx, top - 24, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[24, 24, 440, 16]} />
          <meshStandardMaterial color="#7E8B98" roughness={0.35} metalness={0.6} />
        </mesh>
      ))}

      {/* pés com rodízios */}
      {[[-620, -190], [-620, 190], [620, -190], [620, 190]].map(([px, pz], i) => (
        <group key={i} position={[px, 0, pz]}>
          <mesh position={[0, (top - 90) / 2 + 60, 0]} castShadow>
            <boxGeometry args={[60, top - 90, 60]} />
            <meshStandardMaterial color={FERRO} roughness={0.6} />
          </mesh>
          <mesh position={[0, 40, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[38, 38, 30, 14]} />
            <meshStandardMaterial color="#11161C" roughness={0.8} />
          </mesh>
        </group>
      ))}

      {/* correias laterais vermelhas que arrastam a caixa */}
      {[-115, 115].map((pz, i) => (
        <mesh key={i} position={[0, top + 250, pz]} castShadow>
          <boxGeometry args={[950, 260, 55]} />
          <meshStandardMaterial color={VERMELHO} roughness={0.6} />
        </mesh>
      ))}

      {/* pórtico: colunas, travessa e o cabeçote de fita */}
      {[-265, 265].map((pz, i) => (
        <mesh key={i} position={[0, top + 480, pz]} castShadow>
          <boxGeometry args={[65, 960, 65]} />
          <meshStandardMaterial color={CINZA} roughness={0.55} metalness={0.35} />
        </mesh>
      ))}
      <mesh position={[0, top + 935, 0]} castShadow>
        <boxGeometry args={[70, 60, 590]} />
        <meshStandardMaterial color={CINZA} roughness={0.55} metalness={0.35} />
      </mesh>
      {/* o cabeçote, vermelho, pendurado sobre a passagem */}
      <mesh position={[0, top + 700, 0]} castShadow>
        <boxGeometry args={[330, 230, 170]} />
        <meshStandardMaterial color={VERMELHO} roughness={0.55} />
      </mesh>
      {[-95, 95].map((px, i) => (
        <mesh key={i} position={[px, top + 565, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[42, 42, 150, 16]} />
          <meshStandardMaterial color={VERMELHO} roughness={0.5} />
        </mesh>
      ))}
      {/* o rolo de fita, amarelo, no alto do cabeçote */}
      <mesh position={[0, top + 855, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[78, 78, 55, 20]} />
        <meshStandardMaterial color="#D9C36A" roughness={0.5} />
      </mesh>
    </group>
  );
}

/** A caixa que chega: anda pela esteira, para nos roletes da balança e some
 *  quando as ventosas a levam. A posição vem do servidor a cada quadro. */
function CaixaNaEsteira({ live, pick, box }: {
  live: React.MutableRefObject<RobotState | null>;
  pick: { r: number; top: number };
  box: { w: number; d: number; h: number };
}) {
  const ref = useRef<THREE.Group>(null!);
  useFrame((_s, dt) => {
    const st = live.current;
    if (!st) return;
    ref.current.visible = st.feed !== null;
    if (st.feed) {
      // persegue a posição de rede com amortecimento — anda liso a 60 fps
      const k = Math.min(1, dt * 18);
      ref.current.position.x += (st.feed.x - ref.current.position.x) * k;
    }
  });
  return (
    <group ref={ref} position={[pick.r, pick.top + box.h / 2, 0]}>
      <CaixaVentilador w={box.w} h={box.h} d={box.d} />
    </group>
  );
}

export function Cell({ live, layout, placed }: {
  live: React.MutableRefObject<RobotState | null>;
  layout: HelloMsg["layout"];
  placed: PlacedBox[];
}) {
  return (
    <Canvas
      shadows
      camera={{ position: [3200, 2200, 2800], fov: 40, near: 10, far: 40000 }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={["#0D1319"]} />
      <hemisphereLight args={["#AFC2D8", "#141B22", 0.85]} />
      <ambientLight intensity={0.25} />
      <directionalLight
        position={[1800, 3400, 1200]}
        intensity={1.7}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-3000}
        shadow-camera-right={3000}
        shadow-camera-top={3000}
        shadow-camera-bottom={-3000}
        shadow-camera-far={10000}
      />

      {/* chão que recebe sombra + grade de 500 mm */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[16000, 16000]} />
        <meshStandardMaterial color="#0D1319" roughness={0.95} />
      </mesh>
      <Grid
        position={[0, 1, 0]}
        args={[16000, 16000]}
        cellSize={250}
        cellColor="#1A2530"
        sectionSize={500}
        sectionColor="#22303A"
        fadeDistance={13000}
        fadeStrength={2}
      />

      {/* PEDESTAL: sem ele o GP12 não alcança a 2ª camada da fileira distante */}
      <mesh position={[0, layout.pedestal / 2, 0]} receiveShadow castShadow>
        <boxGeometry args={[500, layout.pedestal, 500]} />
        <meshStandardMaterial color="#39434E" roughness={0.6} metalness={0.35} />
      </mesh>

      {/* base fixa do robô, sobre o pedestal */}
      <group position={[0, layout.pedestal, 0]}>
        <mesh position={[0, 28, 0]} receiveShadow castShadow>
          <boxGeometry args={[430, 56, 430]} />
          <meshStandardMaterial color="#1B2F73" roughness={0.5} metalness={0.25} />
        </mesh>
        <mesh position={[-265, 102, 0]} castShadow>
          <boxGeometry args={[145, 96, 175]} />
          <meshStandardMaterial color="#1B2F73" roughness={0.5} metalness={0.25} />
        </mesh>
        <mesh position={[0, 122, 0]} castShadow>
          <boxGeometry args={[305, 132, 305]} />
          <meshStandardMaterial color="#2E55C6" roughness={0.42} metalness={0.22} />
        </mesh>
      </group>

      <Entrada r={layout.pick.r} top={layout.pick.top} />
      <Palete z={-layout.pallet.r} size={layout.pallet.size} top={layout.pallet.top} />
      <Palete z={+layout.pallet.r} size={layout.pallet.size} top={layout.pallet.top} />

      <CaixaNaEsteira live={live} pick={layout.pick} box={layout.box} />

      {/* a pilha: cada caixa depositada, na posição e orientação do padrão */}
      {placed.map((p, i) => (
        <group key={i} position={[p.x, p.y, p.z]} rotation-y={rad(p.rot)}>
          <CaixaVentilador w={layout.box.w} h={layout.box.h} d={layout.box.d} />
        </group>
      ))}

      <group position={[0, layout.pedestal, 0]}>
        <Robot live={live} />
      </group>

      <OrbitControls
        target={[0, 750, 0]}
        maxPolarAngle={Math.PI / 2 - 0.04}
        minDistance={1500}
        maxDistance={10000}
        enableDamping
      />
    </Canvas>
  );
}
