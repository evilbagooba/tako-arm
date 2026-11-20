# tako-arm — work board

A work board where every task knows which idea it came from. Part of the
[tako](https://github.com/evilbagooba/tako) suite, and usable on its own.

Open a project from the tako hub, or hand it any tako file. Its work items
appear as a board: one lane per node, columns To do / Doing / Done. It is
**track-and-link only**: the work happens elsewhere (a repo, a notebook, a
simulation); this records status, links and what you concluded.

- **Why a task exists.** Open any item to see the node it was spawned from,
  that node's notes, its labelled connections, the paths it is on, and a
  small map of where it sits in the graph.
- **Outcomes in your words.** The outcome field is yours to write; nothing
  fills it in. A finished item with no outcome is flagged, on the card and
  in the board's header.
- **Node state is computed, never stored.** A lane is *untested*, *in
  progress* or *has evidence* by the same rule the slides tool uses, so the
  board shows what a deck would.
- **Promotion is a deliberate step.** "Promote to evidence" asks you for the
  finding and what it does to the claim (supports, weakens, or your own
  label), then adds an evidence node wired to the claim. The node's
  `provenance` is `{ "source": "work", "ref": "<work id>" }`, so the graph
  can trace it back to the item.
- **Nodes with no work** are listed under the board: nothing planned,
  nothing tested.

Every change is a `tako` op (`spawn_work`, `update_work`, `attach_outcome`,
`add_artifact`, `add_node`, …) with undo and redo, so the file this tool
saves is one any other tool in the suite can open.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

**With the hub running** (`tako`, from the tako repo), the start screen
lists the hub's projects. An open project is shared with the other tools:
changes are saved as you make them, edits made in the graph or by another
window appear here live, and undo steps back through changes made in any
tool. The address is `http://localhost:4100`; `?hub=<url>` overrides it, and
`?project=<id>` opens a project directly.

**Without the hub**, open a file. It is read in the browser and never
uploaded. **Save** (Ctrl/Cmd+S) writes back to the file you opened in
browsers with the File System Access API (Chromium), and downloads the
updated file elsewhere.

Undo/redo: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z. Drag a card between columns, or use
its arrow buttons.

## Develop

```sh
npm run typecheck
npm test           # board contract tests against tako's fixtures
```

`src/board.ts` is the framework-free model (project → board, and the op
lists the controls produce); `test/board.test.ts` holds it to the contract
on every tako fixture: every work item is on the board exactly once, and
every op the board builds passes tako's validation and leaves a valid
project.

`tako` is pinned by tag in `package.json`; bump the tag to pick up a new
format version. The app edits a project through tako's `ProjectStore`, so
the hub and file cases share one code path.

## Not yet

Runs (the per-iteration log inside a work item) and pinned metrics need
additions to the format in `tako` first.
