import { useEffect, useMemo, useRef, useState } from "react";

type EcosystemKey = "npm" | "docker" | "python";

export type GraphInputRepo = {
  fullName: string;
  dependencies: { name: string; version: string | null; ecosystem: EcosystemKey }[];
};

export type GraphOutdatedDep = {
  ecosystem: EcosystemKey;
  name: string;
  fromVersion: string | null;
  toVersion: string | null;
  prUrl: string;
  updateType: "patch" | "minor" | "major" | "unknown";
};

type Node = {
  id: string;
  kind: "repo" | "dep";
  label: string;
  ecosystem: EcosystemKey | null;
  usage: number;
  outdated: boolean;
  outdatedType: "patch" | "minor" | "major" | "unknown" | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  r: number;
  pinned: boolean;
};

type Edge = { source: number; target: number };

type Props = {
  repos: GraphInputRepo[];
  outdated: GraphOutdatedDep[];
  ecosystemFilter: Set<EcosystemKey>;
  search: string;
  height?: number;
};

const ECOSYSTEM_COLOR: Record<EcosystemKey, string> = {
  npm: "#22d3ee",
  docker: "#60a5fa",
  python: "#f59e0b",
};

const REPO_COLOR = "#a78bfa";

function buildGraph(
  repos: GraphInputRepo[],
  outdated: GraphOutdatedDep[],
  ecosystemFilter: Set<EcosystemKey>,
  search: string,
): { nodes: Node[]; edges: Edge[] } {
  const outdatedKey = new Map<string, GraphOutdatedDep>();
  for (const o of outdated) {
    outdatedKey.set(`${o.ecosystem}:${normalizeName(o.name)}`, o);
  }

  const depMap = new Map<string, Node>();
  const repoMap = new Map<string, Node>();
  const edges: Edge[] = [];
  const usage = new Map<string, number>();
  const repoOrder: string[] = [];

  for (const repo of repos) {
    const filtered = repo.dependencies.filter((d) => ecosystemFilter.has(d.ecosystem));
    if (filtered.length === 0) continue;
    repoOrder.push(repo.fullName);
    for (const dep of filtered) {
      const key = `${dep.ecosystem}:${normalizeName(dep.name)}`;
      usage.set(key, (usage.get(key) ?? 0) + 1);
    }
  }

  const lowerSearch = search.trim().toLowerCase();
  const searchActive = lowerSearch.length > 0;
  const depKeysInGraph = new Set<string>();

  for (const repo of repos) {
    const filtered = repo.dependencies.filter((d) => ecosystemFilter.has(d.ecosystem));
    if (filtered.length === 0) continue;
    for (const dep of filtered) {
      const key = `${dep.ecosystem}:${normalizeName(dep.name)}`;
      const matchesSearch =
        !searchActive ||
        dep.name.toLowerCase().includes(lowerSearch) ||
        repo.fullName.toLowerCase().includes(lowerSearch);
      if (!matchesSearch) continue;
      depKeysInGraph.add(key);
    }
  }

  const nodes: Node[] = [];
  const idxByKey = new Map<string, number>();
  const centerX = 0;
  const centerY = 0;
  const repoRingR = 360;

  let repoIdx = 0;
  for (const repoName of repoOrder) {
    const angle = (repoIdx / Math.max(1, repoOrder.length)) * Math.PI * 2;
    const node: Node = {
      id: `repo:${repoName}`,
      kind: "repo",
      label: repoName,
      ecosystem: null,
      usage: 0,
      outdated: false,
      outdatedType: null,
      x: centerX + Math.cos(angle) * repoRingR + (Math.random() - 0.5) * 10,
      y: centerY + Math.sin(angle) * repoRingR + (Math.random() - 0.5) * 10,
      vx: 0,
      vy: 0,
      fx: 0,
      fy: 0,
      r: 14,
      pinned: false,
    };
    const repo = repos.find((r) => r.fullName === repoName);
    if (!repo) continue;
    const visibleDeps = repo.dependencies.filter(
      (d) =>
        ecosystemFilter.has(d.ecosystem) &&
        depKeysInGraph.has(`${d.ecosystem}:${normalizeName(d.name)}`),
    );
    if (visibleDeps.length === 0 && searchActive) {
      // Don't include repo if no visible deps under search
      continue;
    }
    idxByKey.set(node.id, nodes.length);
    repoMap.set(repoName, node);
    nodes.push(node);
    repoIdx++;
  }

  for (const repo of repos) {
    const visibleDeps = repo.dependencies.filter(
      (d) =>
        ecosystemFilter.has(d.ecosystem) &&
        depKeysInGraph.has(`${d.ecosystem}:${normalizeName(d.name)}`),
    );
    for (const dep of visibleDeps) {
      const key = `${dep.ecosystem}:${normalizeName(dep.name)}`;
      const usageCount = usage.get(key) ?? 1;
      let depNode = depMap.get(key);
      if (!depNode) {
        const baseR = 5;
        const r = Math.min(22, baseR + Math.sqrt(usageCount) * 3.2);
        const od = outdatedKey.get(key);
        depNode = {
          id: `dep:${key}`,
          kind: "dep",
          label: dep.name,
          ecosystem: dep.ecosystem,
          usage: usageCount,
          outdated: Boolean(od),
          outdatedType: od?.updateType ?? null,
          x: (Math.random() - 0.5) * 200,
          y: (Math.random() - 0.5) * 200,
          vx: 0,
          vy: 0,
          fx: 0,
          fy: 0,
          r,
          pinned: false,
        };
        idxByKey.set(depNode.id, nodes.length);
        depMap.set(key, depNode);
        nodes.push(depNode);
      }
      const repoNode = repoMap.get(repo.fullName);
      if (!repoNode) continue;
      const repoIndex = idxByKey.get(repoNode.id);
      const depIndex = idxByKey.get(depNode.id);
      if (repoIndex == null || depIndex == null) continue;
      edges.push({ source: repoIndex, target: depIndex });
    }
  }

  return { nodes, edges };
}

function normalizeName(name: string): string {
  return name.toLowerCase().trim();
}

const REPEL = 1400;
const SPRING_K = 0.02;
const SPRING_LEN = 95;
const GRAVITY = 0.012;
const DAMPING = 0.82;
const MAX_VELOCITY = 12;

export function DependencyGraph({ repos, outdated, ecosystemFilter, search, height = 620 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(1100);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(Math.max(640, Math.floor(entry.contentRect.width)));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { nodes: initialNodes, edges } = useMemo(
    () => buildGraph(repos, outdated, ecosystemFilter, search),
    [repos, outdated, ecosystemFilter, search],
  );

  const nodesRef = useRef<Node[]>([]);
  const [, setTick] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState({
    x: -containerWidth / 2,
    y: -height / 2,
    w: containerWidth,
    h: height,
  });
  const panRef = useRef<{ startX: number; startY: number; vx: number; vy: number } | null>(null);
  const panMovedRef = useRef(false);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const nodeClickStartRef = useRef<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    setViewBox((vb) => ({ ...vb, w: containerWidth, x: -containerWidth / 2 }));
  }, [containerWidth]);

  useEffect(() => {
    setViewBox((vb) => ({ ...vb, h: height, y: -height / 2 }));
  }, [height]);

  useEffect(() => {
    nodesRef.current = initialNodes.map((n) => ({ ...n }));
    setHoverId(null);
    setFocusId(null);
    setDragId(null);
    let raf = 0;
    let iter = 0;
    const maxIter = 700;
    let alpha = 1;
    const minAlpha = 0.005;

    const step = () => {
      const nodes = nodesRef.current;
      if (nodes.length === 0) return;

      for (const n of nodes) {
        n.fx = 0;
        n.fy = 0;
      }

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (!a) continue;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          if (!b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy + 0.01;
          const inv = REPEL / d2;
          const d = Math.sqrt(d2);
          const fxk = (inv * dx) / d;
          const fyk = (inv * dy) / d;
          a.fx -= fxk;
          a.fy -= fyk;
          b.fx += fxk;
          b.fy += fyk;
        }
      }

      for (const e of edges) {
        const a = nodes[e.source];
        const b = nodes[e.target];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = SPRING_K * (d - SPRING_LEN);
        const fx = (f * dx) / d;
        const fy = (f * dy) / d;
        a.fx += fx;
        a.fy += fy;
        b.fx -= fx;
        b.fy -= fy;
      }

      for (const n of nodes) {
        n.fx -= GRAVITY * n.x;
        n.fy -= GRAVITY * n.y;
      }

      let energy = 0;
      for (const n of nodes) {
        if (n.pinned) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx = (n.vx + n.fx * alpha) * DAMPING;
        n.vy = (n.vy + n.fy * alpha) * DAMPING;
        const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (speed > MAX_VELOCITY) {
          n.vx = (n.vx / speed) * MAX_VELOCITY;
          n.vy = (n.vy / speed) * MAX_VELOCITY;
        }
        n.x += n.vx;
        n.y += n.vy;
        energy += n.vx * n.vx + n.vy * n.vy;
      }

      alpha = Math.max(minAlpha, alpha * 0.992);
      iter++;
      setTick((t) => t + 1);

      const avgEnergy = energy / Math.max(1, nodes.length);
      if (iter < maxIter && avgEnergy > 0.0015) {
        raf = requestAnimationFrame(step);
      }
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [edges, initialNodes]);

  const nodes = nodesRef.current;

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      const a = nodes[e.source];
      const b = nodes[e.target];
      if (!a || !b) continue;
      if (!map.has(a.id)) map.set(a.id, new Set());
      if (!map.has(b.id)) map.set(b.id, new Set());
      map.get(a.id)?.add(b.id);
      map.get(b.id)?.add(a.id);
    }
    return map;
  }, [edges, nodes]);

  const activeId = focusId ?? hoverId;

  const highlightedIds = useMemo(() => {
    if (!activeId) return null;
    const set = new Set<string>([activeId]);
    for (const id of adjacency.get(activeId) ?? []) set.add(id);
    return set;
  }, [activeId, adjacency]);

  const topHubIds = useMemo(() => {
    const sorted = initialNodes.filter((n) => n.kind === "dep").sort((a, b) => b.usage - a.usage);
    return new Set(sorted.slice(0, 5).map((n) => n.id));
  }, [initialNodes]);

  const repoHealth = useMemo(() => {
    const map = new Map<string, { total: number; outdated: number }>();
    for (const e of edges) {
      const repo = initialNodes[e.source];
      const dep = initialNodes[e.target];
      if (!repo || !dep || repo.kind !== "repo") continue;
      const entry = map.get(repo.id) ?? { total: 0, outdated: 0 };
      entry.total++;
      if (dep.outdated) entry.outdated++;
      map.set(repo.id, entry);
    }
    return map;
  }, [edges, initialNodes]);

  function svgPointFromEvent(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const el = containerRef.current?.querySelector("svg");
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    return { x: viewBox.x + px * viewBox.w, y: viewBox.y + py * viewBox.h };
  }

  function onSvgWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.0015);
    const pt = svgPointFromEvent(e);
    setViewBox((vb) => {
      const newW = Math.min(8000, Math.max(200, vb.w * factor));
      const newH = Math.min(8000, Math.max(120, vb.h * factor));
      const newX = pt.x - ((pt.x - vb.x) * newW) / vb.w;
      const newY = pt.y - ((pt.y - vb.y) * newH) / vb.h;
      return { x: newX, y: newY, w: newW, h: newH };
    });
  }

  function onSvgMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    if (dragId) return;
    const pt = svgPointFromEvent(e);
    panRef.current = { startX: pt.x, startY: pt.y, vx: viewBox.x, vy: viewBox.y };
    panMovedRef.current = false;
  }

  function onSvgMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const pt = svgPointFromEvent(e);
    if (dragId) {
      const offset = dragOffsetRef.current;
      const n = nodes.find((x) => x.id === dragId);
      if (n && offset) {
        n.x = pt.x - offset.dx;
        n.y = pt.y - offset.dy;
        n.vx = 0;
        n.vy = 0;
        setTick((t) => t + 1);
      }
      return;
    }
    if (panRef.current) {
      const dx = pt.x - panRef.current.startX;
      const dy = pt.y - panRef.current.startY;
      if (!panMovedRef.current && dx * dx + dy * dy > 9) {
        panMovedRef.current = true;
      }
      setViewBox((vb) => ({
        ...vb,
        x: panRef.current!.vx - dx,
        y: panRef.current!.vy - dy,
      }));
    }
  }

  function onSvgMouseUp() {
    if (dragId) {
      const n = nodes.find((x) => x.id === dragId);
      const start = nodeClickStartRef.current;
      if (n && start && start.id === n.id) {
        const dx = n.x - start.x;
        const dy = n.y - start.y;
        if (dx * dx + dy * dy < 9) {
          setFocusId((prev) => (prev === n.id ? null : n.id));
        }
      }
      if (n) n.pinned = false;
      setDragId(null);
      dragOffsetRef.current = null;
      nodeClickStartRef.current = null;
    } else if (panRef.current && !panMovedRef.current) {
      setFocusId(null);
    }
    panRef.current = null;
    panMovedRef.current = false;
  }

  function onNodeMouseDown(e: React.MouseEvent<SVGElement>, n: Node) {
    e.stopPropagation();
    const pt = svgPointFromEvent(e);
    dragOffsetRef.current = { dx: pt.x - n.x, dy: pt.y - n.y };
    nodeClickStartRef.current = { id: n.id, x: n.x, y: n.y };
    n.pinned = true;
    setDragId(n.id);
  }

  function resetView() {
    setViewBox({ x: -containerWidth / 2, y: -height / 2, w: containerWidth, h: height });
  }

  const stats = useMemo(() => {
    let depNodes = 0;
    let repoNodes = 0;
    let outdatedNodes = 0;
    for (const n of initialNodes) {
      if (n.kind === "dep") {
        depNodes++;
        if (n.outdated) outdatedNodes++;
      } else {
        repoNodes++;
      }
    }
    return { depNodes, repoNodes, outdatedNodes, edges: edges.length };
  }, [initialNodes, edges]);

  const activeNode = activeId ? (nodes.find((n) => n.id === activeId) ?? null) : null;
  const activeHealth = activeNode?.kind === "repo" ? (repoHealth.get(activeNode.id) ?? null) : null;

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1 text-[11px] text-muted-foreground">
        <div className="rounded-md border bg-background/80 px-2 py-1 backdrop-blur-sm">
          <span className="font-medium text-foreground">{stats.repoNodes}</span> repos •{" "}
          <span className="font-medium text-foreground">{stats.depNodes}</span> deps •{" "}
          <span className="font-medium text-foreground">{stats.edges}</span> edges
          {stats.outdatedNodes > 0 ? (
            <>
              {" • "}
              <span className="font-medium text-amber-400">{stats.outdatedNodes}</span> outdated
            </>
          ) : null}
        </div>
      </div>

      <div className="pointer-events-auto absolute right-3 top-3 z-10 flex items-center gap-1">
        <button
          type="button"
          onClick={resetView}
          className="rounded-md border bg-background/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur-sm hover:text-foreground"
        >
          Reset view
        </button>
      </div>

      <Legend />

      <svg
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Dependency network graph"
        onWheel={onSvgWheel}
        onMouseDown={onSvgMouseDown}
        onMouseMove={onSvgMouseMove}
        onMouseUp={onSvgMouseUp}
        onMouseLeave={onSvgMouseUp}
        className={`block touch-none select-none ${dragId ? "cursor-grabbing" : "cursor-grab"}`}
        style={{
          background: "radial-gradient(circle at center, hsl(var(--muted)/0.18), transparent 70%)",
        }}
      >
        <title>Dependency network graph</title>
        <defs>
          <radialGradient id="dep-npm" cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#67e8f9" />
            <stop offset="100%" stopColor="#0891b2" />
          </radialGradient>
          <radialGradient id="dep-docker" cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#93c5fd" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </radialGradient>
          <radialGradient id="dep-python" cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#fcd34d" />
            <stop offset="100%" stopColor="#b45309" />
          </radialGradient>
          <radialGradient id="repo-grad" cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#c4b5fd" />
            <stop offset="100%" stopColor="#6d28d9" />
          </radialGradient>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g>
          {edges.map((e) => {
            const a = nodes[e.source];
            const b = nodes[e.target];
            if (!a || !b) return null;
            const highlighted = highlightedIds?.has(a.id) && highlightedIds.has(b.id);
            const dimmed = highlightedIds && !highlighted;
            const dep = a.kind === "dep" ? a : b;
            const ecoColor = dep?.ecosystem ? ECOSYSTEM_COLOR[dep.ecosystem] : null;
            const stroke = highlighted ? "#a78bfa" : (ecoColor ?? "currentColor");
            return (
              <line
                key={`${a.id}->${b.id}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={stroke}
                strokeWidth={highlighted ? 1.2 : 0.55}
                opacity={dimmed ? 0.05 : highlighted ? 0.9 : ecoColor ? 0.22 : 0.18}
                className="text-muted-foreground transition-opacity"
              />
            );
          })}
        </g>

        <g>
          {nodes.map((n) => {
            const highlighted = highlightedIds ? highlightedIds.has(n.id) : true;
            const isHover = hoverId === n.id;
            const isFocus = focusId === n.id;
            const isHub = topHubIds.has(n.id);
            const fill =
              n.kind === "repo"
                ? "url(#repo-grad)"
                : n.ecosystem
                  ? `url(#dep-${n.ecosystem})`
                  : "#94a3b8";
            const stroke = isFocus
              ? "#ffffff"
              : n.outdated
                ? outdatedColor(n.outdatedType)
                : "rgba(255,255,255,0.18)";
            const strokeWidth = isFocus ? 2.5 : n.outdated ? 2 : 1;
            const health = n.kind === "repo" ? repoHealth.get(n.id) : null;
            const isCleanRepo = !!health && health.total > 0 && health.outdated === 0;
            const labelVisible =
              n.kind === "repo" || isHover || isFocus || isHub || (highlightedIds && highlighted);
            const pulseDur = pulseDuration(n.outdatedType);
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: SVG node, no semantic equivalent
              <g
                key={n.id}
                aria-label={n.kind === "repo" ? `Repository ${n.label}` : `Dependency ${n.label}`}
                transform={`translate(${n.x},${n.y})`}
                onMouseEnter={() => setHoverId(n.id)}
                onMouseLeave={() => setHoverId((prev) => (prev === n.id ? null : prev))}
                onMouseDown={(e) => onNodeMouseDown(e, n)}
                className="cursor-pointer"
                opacity={highlighted ? 1 : 0.22}
                style={{ transition: "opacity 120ms" }}
              >
                {n.outdated ? (
                  <circle
                    r={n.r + 4}
                    fill="none"
                    stroke={outdatedColor(n.outdatedType)}
                    strokeWidth={1.2}
                    opacity={0.4}
                  >
                    <animate
                      attributeName="r"
                      values={`${n.r + 3};${n.r + 8};${n.r + 3}`}
                      dur={pulseDur}
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0.15;0.55;0.15"
                      dur={pulseDur}
                      repeatCount="indefinite"
                    />
                  </circle>
                ) : null}
                {isCleanRepo ? (
                  <circle
                    r={n.r + 5}
                    fill="none"
                    stroke={HEALTHY_COLOR}
                    strokeWidth={1.2}
                    opacity={0.45}
                  >
                    <animate
                      attributeName="opacity"
                      values="0.2;0.55;0.2"
                      dur="2.8s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="r"
                      values={`${n.r + 4};${n.r + 7};${n.r + 4}`}
                      dur="2.8s"
                      repeatCount="indefinite"
                    />
                  </circle>
                ) : null}
                <circle
                  r={n.r}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  filter={isHover || isFocus ? "url(#glow)" : undefined}
                />
                {labelVisible ? (
                  <text
                    y={n.r + 10}
                    textAnchor="middle"
                    className="pointer-events-none fill-foreground"
                    style={{
                      fontSize: n.kind === "repo" || isHub ? 11 : 10,
                      fontWeight: n.kind === "repo" || isHub ? 600 : 400,
                      paintOrder: "stroke",
                      stroke: "hsl(var(--background))",
                      strokeWidth: 3,
                      strokeLinejoin: "round",
                    }}
                  >
                    {truncate(n.kind === "repo" ? shortRepoName(n.label) : n.label, 28)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      {activeNode ? (
        <HoverPanel
          node={activeNode}
          adjacency={adjacency}
          nodes={nodes}
          health={activeHealth}
          pinned={focusId === activeNode.id}
        />
      ) : null}
    </div>
  );
}

function outdatedColor(t: "patch" | "minor" | "major" | "unknown" | null): string {
  if (t === "major") return "#ef4444";
  if (t === "minor") return "#f59e0b";
  if (t === "patch") return "#10b981";
  return "#f59e0b";
}

function pulseDuration(t: "patch" | "minor" | "major" | "unknown" | null): string {
  if (t === "major") return "1s";
  if (t === "minor") return "1.6s";
  if (t === "patch") return "2.4s";
  return "1.6s";
}

const HEALTHY_COLOR = "#10b981";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function shortRepoName(full: string): string {
  const idx = full.indexOf("/");
  return idx >= 0 ? full.slice(idx + 1) : full;
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex flex-col gap-1.5 rounded-md border bg-background/80 p-2 text-[11px] backdrop-blur-sm">
      <LegendDot color={REPO_COLOR} label="repository" />
      <LegendDot color={ECOSYSTEM_COLOR.npm} label="npm" />
      <LegendDot color={ECOSYSTEM_COLOR.docker} label="docker" />
      <LegendDot color={ECOSYSTEM_COLOR.python} label="python" />
      <div className="mt-1 flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-amber-400 bg-transparent" />
        <span className="text-muted-foreground">outdated</span>
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ background: color }}
        aria-hidden
      />
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

function HoverPanel({
  node,
  adjacency,
  nodes,
  health,
  pinned,
}: {
  node: Node;
  adjacency: Map<string, Set<string>>;
  nodes: Node[];
  health: { total: number; outdated: number } | null;
  pinned: boolean;
}) {
  const connected = adjacency.get(node.id) ?? new Set();
  const others = nodes.filter((n) => connected.has(n.id));
  const isRepo = node.kind === "repo";
  const freshPct =
    health && health.total > 0
      ? Math.round(((health.total - health.outdated) / health.total) * 100)
      : null;
  const healthColor =
    freshPct == null
      ? null
      : freshPct === 100
        ? HEALTHY_COLOR
        : freshPct >= 80
          ? "#f59e0b"
          : "#ef4444";
  return (
    <div className="pointer-events-none absolute right-3 bottom-3 z-10 max-w-[320px] rounded-lg border bg-background/95 p-3 text-xs shadow-lg backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-3 w-3 rounded-full"
          style={{
            background: isRepo
              ? REPO_COLOR
              : node.ecosystem
                ? ECOSYSTEM_COLOR[node.ecosystem]
                : "#94a3b8",
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate font-semibold text-sm text-foreground">{node.label}</div>
            {pinned ? (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary">
                focused
              </span>
            ) : null}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {isRepo ? "repository" : (node.ecosystem ?? "unknown")}
            {node.outdated ? ` • ${node.outdatedType ?? "outdated"} update available` : null}
          </div>
        </div>
      </div>
      <div className="mt-2 text-muted-foreground">
        {isRepo
          ? `${others.length} ${others.length === 1 ? "dependency" : "dependencies"}`
          : `used by ${others.length} ${others.length === 1 ? "repo" : "repos"}`}
      </div>
      {isRepo && freshPct != null && healthColor ? (
        <div className="mt-2">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>freshness</span>
            <span style={{ color: healthColor }} className="font-semibold tabular-nums">
              {freshPct}%
            </span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${freshPct}%`, background: healthColor }}
            />
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {health && health.outdated === 0
              ? `all ${health.total} deps fresh`
              : `${health?.outdated ?? 0} of ${health?.total ?? 0} outdated`}
          </div>
        </div>
      ) : null}
      {others.length > 0 ? (
        <div className="mt-2 max-h-40 overflow-y-auto">
          <ul className="space-y-0.5">
            {others.slice(0, 12).map((o) => (
              <li
                key={o.id}
                className="truncate font-mono text-[11px] text-foreground/80"
                title={o.label}
              >
                {o.kind === "repo" ? shortRepoName(o.label) : o.label}
              </li>
            ))}
            {others.length > 12 ? (
              <li className="text-[10px] italic text-muted-foreground">
                +{others.length - 12} more
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
