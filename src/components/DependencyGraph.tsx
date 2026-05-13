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
  const [dragId, setDragId] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState({
    x: -containerWidth / 2,
    y: -height / 2,
    w: containerWidth,
    h: height,
  });
  const panRef = useRef<{ startX: number; startY: number; vx: number; vy: number } | null>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    setViewBox((vb) => ({ ...vb, w: containerWidth, x: -containerWidth / 2 }));
  }, [containerWidth]);

  useEffect(() => {
    setViewBox((vb) => ({ ...vb, h: height, y: -height / 2 }));
  }, [height]);

  useEffect(() => {
    nodesRef.current = initialNodes.map((n) => ({ ...n }));
    setHoverId(null);
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

  const highlightedIds = useMemo(() => {
    if (!hoverId) return null;
    const set = new Set<string>([hoverId]);
    for (const id of adjacency.get(hoverId) ?? []) set.add(id);
    return set;
  }, [hoverId, adjacency]);

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
      setViewBox((vb) => ({
        ...vb,
        x: panRef.current!.vx - (pt.x - panRef.current!.startX),
        y: panRef.current!.vy - (pt.y - panRef.current!.startY),
      }));
    }
  }

  function onSvgMouseUp() {
    if (dragId) {
      const n = nodes.find((x) => x.id === dragId);
      if (n) n.pinned = false;
      setDragId(null);
      dragOffsetRef.current = null;
    }
    panRef.current = null;
  }

  function onNodeMouseDown(e: React.MouseEvent<SVGElement>, n: Node) {
    e.stopPropagation();
    const pt = svgPointFromEvent(e);
    dragOffsetRef.current = { dx: pt.x - n.x, dy: pt.y - n.y };
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

  const hoveredNode = hoverId ? (nodes.find((n) => n.id === hoverId) ?? null) : null;

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
            return (
              <line
                key={`${a.id}->${b.id}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={highlighted ? "#a78bfa" : "currentColor"}
                strokeWidth={highlighted ? 1.2 : 0.6}
                opacity={dimmed ? 0.05 : highlighted ? 0.9 : 0.18}
                className="text-muted-foreground transition-opacity"
              />
            );
          })}
        </g>

        <g>
          {nodes.map((n) => {
            const highlighted = highlightedIds ? highlightedIds.has(n.id) : true;
            const isHover = hoverId === n.id;
            const fill =
              n.kind === "repo"
                ? "url(#repo-grad)"
                : n.ecosystem
                  ? `url(#dep-${n.ecosystem})`
                  : "#94a3b8";
            const stroke = n.outdated ? outdatedColor(n.outdatedType) : "rgba(255,255,255,0.18)";
            const strokeWidth = n.outdated ? 2 : 1;
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
                opacity={highlighted ? 1 : 0.25}
                style={{ transition: "opacity 120ms" }}
              >
                {n.outdated ? (
                  <circle
                    r={n.r + 4}
                    fill="none"
                    stroke={outdatedColor(n.outdatedType)}
                    strokeWidth={1}
                    opacity={0.4}
                  />
                ) : null}
                <circle
                  r={n.r}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  filter={isHover ? "url(#glow)" : undefined}
                />
                {n.kind === "repo" || isHover || (highlightedIds && highlighted) ? (
                  <text
                    y={n.r + 10}
                    textAnchor="middle"
                    className="pointer-events-none fill-foreground"
                    style={{
                      fontSize: n.kind === "repo" ? 11 : 10,
                      fontWeight: n.kind === "repo" ? 600 : 400,
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

      {hoveredNode ? <HoverPanel node={hoveredNode} adjacency={adjacency} nodes={nodes} /> : null}
    </div>
  );
}

function outdatedColor(t: "patch" | "minor" | "major" | "unknown" | null): string {
  if (t === "major") return "#ef4444";
  if (t === "minor") return "#f59e0b";
  if (t === "patch") return "#10b981";
  return "#f59e0b";
}

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
}: {
  node: Node;
  adjacency: Map<string, Set<string>>;
  nodes: Node[];
}) {
  const connected = adjacency.get(node.id) ?? new Set();
  const others = nodes.filter((n) => connected.has(n.id));
  const isRepo = node.kind === "repo";
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
          <div className="truncate font-semibold text-sm text-foreground">{node.label}</div>
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
