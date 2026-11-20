// The work board's model: project → board, and the op lists its controls
// produce. Track-and-link only: nothing here runs work, it records status,
// outcomes and links, and keeps every item tied to the idea it came from.
//
// Pure and framework-free, so it's tested against tako's fixture projects.
// Every change is expressed as tako ops; this module never edits a project.

import type { Artifact, Narrative, Op, Project, ProjectEdge, ProjectNode, Work } from "tako/model";

export type Status = Work["status"];
export const STATUSES: readonly Status[] = ["todo", "doing", "done"];
export const STATUS_LABEL: Record<Status, string> = { todo: "To do", doing: "Doing", done: "Done" };

/** Kinds offered when none has been typed yet; any string is allowed. */
export const SUGGESTED_KINDS = ["task", "experiment", "reading", "ticket", "prototype", "interview"];

/** How an evidence node records the work item it was promoted from, in the
 * node's `provenance`: `{ source: "work", ref: <work id> }`. */
export const WORK_PROVENANCE = "work";

/**
 * Where a node stands, computed from its work and evidence, never stored:
 * - supported: a finished work item has an outcome, or an evidence node is
 *   wired to it (the same rule the slides tool uses, so the board predicts
 *   what a deck will show);
 * - in-progress: work is under way, nothing concluded yet;
 * - untested: neither;
 * - evidence: the node is itself an evidence node.
 */
export type Rollup = "untested" | "in-progress" | "supported" | "evidence";

export type Card = {
  work: Work;
  artifacts: Artifact[];
  /** Evidence nodes promoted from this item. */
  promoted: ProjectNode[];
  /** Done, but the outcome was never written down. */
  missingOutcome: boolean;
};

export type Lane = {
  node: ProjectNode;
  rollup: Rollup;
  columns: Record<Status, Card[]>;
  /** Cards shown in this lane (after filtering). */
  shown: number;
};

export type Board = {
  lanes: Lane[];
  /** Nodes with no work at all: nothing planned, nothing tested. */
  idle: ProjectNode[];
  /** Counts over the whole project, ignoring the filter. */
  totals: Record<Status, number>;
  missingOutcomes: number;
  /** Work kinds in use, in first-seen order. */
  kinds: string[];
};

export type Filter = { kind?: string; query?: string };

const isEvidence = (n: ProjectNode | undefined) => n?.kind === "evidence";

function evidenceNeighbours(p: Project, nodeId: string): ProjectNode[] {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const out: ProjectNode[] = [];
  for (const e of p.edges) {
    const otherId = e.to === nodeId ? e.from : e.from === nodeId ? e.to : null;
    const other = otherId ? byId.get(otherId) : undefined;
    if (other && isEvidence(other) && !out.includes(other)) out.push(other);
  }
  return out;
}

export function rollupOf(p: Project, nodeId: string): Rollup {
  const node = p.nodes.find((n) => n.id === nodeId);
  if (isEvidence(node)) return "evidence";
  const work = p.work.filter((w) => w.nodeId === nodeId);
  if (work.some((w) => w.status === "done" && w.outcome.trim()) || evidenceNeighbours(p, nodeId).length) {
    return "supported";
  }
  return work.some((w) => w.status === "doing") ? "in-progress" : "untested";
}

/** Evidence nodes that were promoted from this work item. */
export function promotionsOf(p: Project, workId: string): ProjectNode[] {
  return p.nodes.filter(
    (n) => isEvidence(n) && n.provenance?.source === WORK_PROVENANCE && n.provenance.ref === workId,
  );
}

export function cardOf(p: Project, work: Work): Card {
  return {
    work,
    artifacts: p.artifacts.filter((a) => a.workId === work.id),
    promoted: promotionsOf(p, work.id),
    missingOutcome: work.status === "done" && !work.outcome.trim(),
  };
}

export function buildBoard(p: Project, filter: Filter = {}): Board {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const totals: Record<Status, number> = { todo: 0, doing: 0, done: 0 };
  const kinds: string[] = [];
  let missingOutcomes = 0;
  const byNode = new Map<string, Work[]>();
  for (const w of p.work) {
    totals[w.status]++;
    if (w.status === "done" && !w.outcome.trim()) missingOutcomes++;
    if (w.kind && !kinds.includes(w.kind)) kinds.push(w.kind);
    const list = byNode.get(w.nodeId);
    if (list) list.push(w);
    else byNode.set(w.nodeId, [w]);
  }

  const lanes: Lane[] = [];
  const idle: ProjectNode[] = [];
  for (const node of p.nodes) {
    const work = byNode.get(node.id);
    if (!work) {
      // Evidence nodes are conclusions, not claims waiting for work.
      if (!isEvidence(node)) idle.push(node);
      continue;
    }
    const nodeMatches = query !== "" && node.title.toLowerCase().includes(query);
    const columns: Record<Status, Card[]> = { todo: [], doing: [], done: [] };
    let shown = 0;
    for (const w of work) {
      if (filter.kind && w.kind !== filter.kind) continue;
      if (query && !nodeMatches && !`${w.title}\n${w.outcome}`.toLowerCase().includes(query)) continue;
      columns[w.status].push(cardOf(p, w));
      shown++;
    }
    if (shown === 0 && (filter.kind || query)) continue;
    lanes.push({ node, rollup: rollupOf(p, node.id), columns, shown });
  }
  return { lanes, idle, totals, missingOutcomes, kinds };
}

// ---- Why a task exists ----

export type Connection = {
  edge: ProjectEdge;
  other: ProjectNode;
  /** out: this node → other. */
  direction: "out" | "in";
};

export type NodeContext = {
  node: ProjectNode;
  rollup: Rollup;
  connections: Connection[];
  /** Paths that visit this node, with its 1-based stop number. */
  paths: { narrative: Narrative; stop: number; of: number }[];
  work: Work[];
};

/** A node's place in the graph: what it connects to (with the labels, which
 * carry the meaning) and which paths pass through it. */
export function nodeContext(p: Project, nodeId: string): NodeContext | null {
  const node = p.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const connections: Connection[] = [];
  for (const edge of p.edges) {
    const out = edge.from === nodeId;
    if (!out && edge.to !== nodeId) continue;
    const other = byId.get(out ? edge.to : edge.from);
    if (other) connections.push({ edge, other, direction: out ? "out" : "in" });
  }
  const paths = p.narratives.flatMap((narrative) => {
    const i = narrative.nodeIds.indexOf(nodeId);
    return i < 0 ? [] : [{ narrative, stop: i + 1, of: narrative.nodeIds.length }];
  });
  return { node, rollup: rollupOf(p, nodeId), connections, paths, work: p.work.filter((w) => w.nodeId === nodeId) };
}

// ---- Ops ----

export function spawnWork(id: string, nodeId: string, title: string, kind = "task"): Op[] {
  return [{ type: "spawn_work", work: { id, nodeId, title, kind, status: "todo", outcome: "", link: "" } }];
}

export function setStatus(work: Work, status: Status): Op[] {
  return work.status === status ? [] : [{ type: "update_work", id: work.id, patch: { status } }];
}

export function addArtifact(id: string, work: Work, title: string, link: string): Op[] {
  const isImage = /\.(png|jpe?g|gif|webp|avif|svg)(\?\S*)?$/i.test(link);
  return [
    {
      type: "add_artifact",
      artifact: { id, nodeId: work.nodeId, workId: work.id, title, kind: isImage ? "image" : "link", link },
    },
  ];
}

const NODE_SIZE: Record<ProjectNode["size"], number> = { sm: 108, md: 136, lg: 168, xl: 204 };

/** A free spot beside `node` for a new small node: the direction (of eight)
 * that keeps it furthest from everything else on the canvas. */
function spotBeside(p: Project, node: ProjectNode): { x: number; y: number } {
  const d = NODE_SIZE[node.size] / 2 + NODE_SIZE.sm / 2 + 70;
  let best = { x: node.x + d, y: node.y };
  let bestClearance = -1;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const spot = { x: Math.round(node.x + d * Math.cos(a)), y: Math.round(node.y + d * Math.sin(a)) };
    let clearance = Infinity;
    for (const n of p.nodes) {
      if (n.id !== node.id) clearance = Math.min(clearance, Math.hypot(n.x - spot.x, n.y - spot.y));
    }
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = spot;
    }
  }
  return best;
}

export type Promotion = {
  /** Ids for the new evidence node and its edge. */
  nodeId: string;
  edgeId: string;
  /** The finding, in the author's own words. Never generated. */
  finding: string;
  /** The edge label: what the finding does to the claim ("supports",
   * "weakens", or the author's own wording). */
  relation: string;
};

/**
 * Promote a work item's conclusion into the graph: an evidence node carrying
 * the author's finding, wired to the node the work came from, with
 * provenance pointing back at the work item. A deliberate step, taken by
 * the author; nothing calls this automatically.
 *
 * The evidence node's notes are the work item's outcome and its subtitle is
 * the work item's title, both copied verbatim.
 */
export function promoteWork(p: Project, workId: string, promotion: Promotion): Op[] {
  const work = p.work.find((w) => w.id === workId);
  if (!work) throw new Error(`No work item "${workId}".`);
  const node = p.nodes.find((n) => n.id === work.nodeId);
  if (!node) throw new Error(`Work item "${workId}" points at a node that no longer exists.`);
  const finding = promotion.finding.trim();
  if (!finding) throw new Error("Write the finding first: promotion never fills it in for you.");
  const { x, y } = spotBeside(p, node);
  return [
    {
      type: "add_node",
      node: {
        id: promotion.nodeId,
        title: finding,
        subtitle: work.title.slice(0, 200),
        body: work.outcome,
        color: "paper",
        size: "sm",
        dimmed: false,
        shape: "circle",
        emoji: "",
        image: "",
        kind: "evidence",
        provenance: { source: WORK_PROVENANCE, ref: work.id },
        x,
        y,
      },
    },
    {
      type: "add_edge",
      edge: {
        id: promotion.edgeId,
        from: promotion.nodeId,
        to: node.id,
        label: promotion.relation.trim(),
        style: "solid",
        arrow: "forward",
      },
    },
  ];
}

/** Longest finding promotion accepts (a node title). */
export const FINDING_MAX = 120;
