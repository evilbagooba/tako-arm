// Contract tests: the board against core's fixture projects. If these pass
// after a core bump, the work tool still fits the suite's file format.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { applyOps, migrateProject, parseOps, projectSchema, reviewOps, type Project } from "core";
import {
  STATUSES,
  WORK_PROVENANCE,
  addArtifact,
  buildBoard,
  nodeContext,
  promoteWork,
  promotionsOf,
  rollupOf,
  setStatus,
  spawnWork,
} from "../src/board";

const FIXTURES = ["bird-feeder.json", "sourdough.json", "v0-unversioned.json"];
const load = (name: string): Project =>
  migrateProject(JSON.parse(readFileSync(new URL(import.meta.resolve(`core/fixtures/${name}`)), "utf8")));

/** Ops the board builds must be valid to core (as if they came from
 * outside) and leave a project that still validates. */
function apply(p: Project, ops: ReturnType<typeof spawnWork>): Project {
  assert.deepEqual(parseOps(ops), ops, "ops survive core's validation unchanged");
  assert.equal(reviewOps(p, ops).error, null);
  const next = applyOps(p, ops);
  assert.deepEqual(projectSchema.parse(next), next);
  return next;
}

for (const name of FIXTURES) {
  describe(name, () => {
    const p = load(name);

    it("puts every work item on the board exactly once", () => {
      const board = buildBoard(p);
      const ids = board.lanes.flatMap((l) => STATUSES.flatMap((s) => l.columns[s].map((c) => c.work.id)));
      assert.deepEqual([...ids].sort(), p.work.map((w) => w.id).sort());
      for (const lane of board.lanes) {
        for (const s of STATUSES) {
          for (const c of lane.columns[s]) {
            assert.equal(c.work.status, s);
            assert.equal(c.work.nodeId, lane.node.id);
          }
        }
      }
      assert.equal(board.totals.todo + board.totals.doing + board.totals.done, p.work.length);
    });

    it("accounts for every node: a lane, idle, or evidence", () => {
      const board = buildBoard(p);
      const seen = new Set([...board.lanes.map((l) => l.node.id), ...board.idle.map((n) => n.id)]);
      for (const n of p.nodes) assert.ok(seen.has(n.id) || n.kind === "evidence", n.id);
      assert.equal(seen.size, board.lanes.length + board.idle.length, "no node is in two places");
    });

    it("gives every node a context whose connections are real edges", () => {
      for (const n of p.nodes) {
        const ctx = nodeContext(p, n.id);
        assert.ok(ctx);
        for (const c of ctx.connections) {
          assert.ok(p.edges.includes(c.edge));
          assert.equal(c.direction === "out" ? c.edge.from : c.edge.to, n.id);
        }
        for (const path of ctx.paths) assert.equal(path.narrative.nodeIds[path.stop - 1], n.id);
      }
    });

    it("spawn → doing → done → outcome → artifact → promote, all as valid ops", () => {
      const node = p.nodes.find((n) => n.kind !== "evidence")!;
      let q = apply(p, spawnWork("w-test", node.id, "Try it", "experiment"));
      const before = rollupOf(q, node.id);
      assert.ok(buildBoard(q).lanes.some((l) => l.node.id === node.id && l.columns.todo.some((c) => c.work.id === "w-test")));

      q = apply(q, setStatus(q.work.find((w) => w.id === "w-test")!, "doing"));
      if (before === "untested") assert.equal(rollupOf(q, node.id), "in-progress");

      q = apply(q, setStatus(q.work.find((w) => w.id === "w-test")!, "done"));
      const card = buildBoard(q).lanes.flatMap((l) => l.columns.done).find((c) => c.work.id === "w-test")!;
      assert.equal(card.missingOutcome, true, "done without an outcome is flagged");

      q = apply(q, [{ type: "attach_outcome", workId: "w-test", outcome: "It held." }]);
      assert.equal(rollupOf(q, node.id), "supported");
      assert.equal(buildBoard(q).missingOutcomes, buildBoard(p).missingOutcomes);

      q = apply(q, addArtifact("a-test", q.work.find((w) => w.id === "w-test")!, "Plot", "https://example.com/plot.png"));
      assert.equal(q.artifacts.at(-1)!.kind, "image");

      const promo = { nodeId: "ev-test", edgeId: "e-test", finding: "It holds under load", relation: "supports" };
      q = apply(q, promoteWork(q, "w-test", promo));
      const ev = q.nodes.find((n) => n.id === "ev-test")!;
      // Everything on the evidence node is the author's text, verbatim.
      assert.equal(ev.title, promo.finding);
      assert.equal(ev.body, "It held.");
      assert.equal(ev.subtitle, "Try it");
      assert.equal(ev.kind, "evidence");
      assert.deepEqual(ev.provenance, { source: WORK_PROVENANCE, ref: "w-test" });
      assert.deepEqual(promotionsOf(q, "w-test"), [ev]);
      const edge = q.edges.find((e) => e.id === "e-test")!;
      assert.deepEqual([edge.from, edge.to, edge.label], ["ev-test", node.id, "supports"]);
      // The evidence node doesn't land on top of another node.
      for (const n of q.nodes) if (n !== ev) assert.ok(Math.hypot(n.x - ev.x, n.y - ev.y) > 60, n.id);
      assert.ok(!buildBoard(q).idle.includes(ev), "evidence nodes aren't listed as waiting for work");
    });

    it("removing a work item takes its artifacts but leaves promoted evidence", () => {
      const node = p.nodes[0]!;
      let q = apply(p, spawnWork("w-x", node.id, "X"));
      q = apply(q, addArtifact("a-x", q.work.at(-1)!, "Log", "https://example.com/log.txt"));
      q = apply(q, promoteWork(q, "w-x", { nodeId: "ev-x", edgeId: "e-x", finding: "Found", relation: "weakens" }));
      q = apply(q, [{ type: "remove_work", id: "w-x" }]);
      assert.ok(!q.artifacts.some((a) => a.id === "a-x"));
      assert.ok(q.nodes.some((n) => n.id === "ev-x"));
    });
  });
}

describe("promotion", () => {
  const p = load("sourdough.json");
  it("refuses an empty finding rather than inventing one", () => {
    const w = p.work[0]!;
    assert.throws(() => promoteWork(p, w.id, { nodeId: "n", edgeId: "e", finding: "   ", relation: "supports" }));
  });
});

describe("filter", () => {
  const p = load("sourdough.json");
  it("by kind and by text, without changing the totals", () => {
    const all = buildBoard(p);
    const kind = all.kinds[0]!;
    const byKind = buildBoard(p, { kind });
    for (const l of byKind.lanes) for (const s of STATUSES) for (const c of l.columns[s]) assert.equal(c.work.kind, kind);
    assert.deepEqual(byKind.totals, all.totals);
    const w = p.work[0]!;
    const byText = buildBoard(p, { query: w.title.slice(0, 12).toUpperCase() });
    assert.ok(byText.lanes.some((l) => STATUSES.some((s) => l.columns[s].some((c) => c.work.id === w.id))));
    assert.equal(buildBoard(p, { query: "zzzz-no-such-thing" }).lanes.length, 0);
  });
});
