import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { OpError, createLocalStore, migrateProject, type Op, type Project, type ProjectNode, type ProjectStore, type Work } from "tako";
import { DEFAULT_HUB, connectHub, type Hub, type ProjectSummary } from "tako/client";
import {
  FINDING_MAX,
  STATUSES,
  STATUS_LABEL,
  SUGGESTED_KINDS,
  addArtifact,
  buildBoard,
  cardOf,
  nodeContext,
  promoteWork,
  setStatus,
  spawnWork,
  type Card,
  type Lane,
  type NodeContext,
  type Rollup,
  type Status,
} from "./board";
import { canSaveInPlace, download, droppedFile, pickFile, serialize, writeInPlace, type FileHandle, type OpenedFile } from "./file";

// Node fills, matching the graph tool, so a lane's dot looks like its node.
const COLORS: Record<string, string> = {
  ink: "#1b1b1b",
  paper: "#fafaf7",
  teal: "#dde5e1",
  vermilion: "#ff4d00",
  ochre: "#efe3bc",
  plum: "#e3dfe3",
  sage: "#dfe5d6",
  slate: "#dee1e4",
};
const NODE_SIZE: Record<ProjectNode["size"], number> = { sm: 108, md: 136, lg: 168, xl: 204 };

const ROLLUP_LABEL: Record<Rollup, string> = {
  untested: "Untested",
  "in-progress": "In progress",
  supported: "Has evidence",
  evidence: "Evidence",
};

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const named = (s: string, fallback: string) => s.trim() || fallback;
const isWebLink = (s: string) => /^https?:\/\//i.test(s.trim());
const DRAG_TYPE = "application/x-work-id";

/** An open project: held by the hub (shared with the other tools, saved as
 * you go) or opened from a file (saved when you say so). */
type Loaded = {
  store: ProjectStore;
  key: string;
  source: { kind: "hub"; id: string } | { kind: "file"; name: string; handle: FileHandle | null };
  /** Where the store reports edits the hub refused. */
  rejected: { current: (message: string) => void };
};

const projectParam = () => new URLSearchParams(location.search).get("project");
function setProjectParam(id: string | null) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("project", id);
  else url.searchParams.delete("project");
  history.replaceState(null, "", url);
}

export function App() {
  // undefined: still looking for the hub. null: none running.
  const [hub, setHub] = useState<Hub | null | undefined>(undefined);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openFromHub = useCallback(async (h: Hub, id: string) => {
    const rejected = { current: (_: string) => {} };
    try {
      const store = await h.open(id, { onRejected: (m) => rejected.current(m) });
      setLoaded({ store, key: `hub:${id}:${Date.now()}`, source: { kind: "hub", id }, rejected });
      setProjectParam(id);
      setError(null);
    } catch (e) {
      setProjectParam(null);
      setError(e instanceof Error ? e.message : "Couldn't open that project.");
    }
  }, []);

  useEffect(() => {
    let live = true;
    const url = new URLSearchParams(location.search).get("hub") ?? DEFAULT_HUB;
    void connectHub(url, { clientName: "tako-arm" }).then(async (h) => {
      if (!live) return;
      const id = projectParam();
      if (h && id) await openFromHub(h, id);
      if (live) setHub(h);
    });
    return () => {
      live = false;
    };
  }, [openFromHub]);

  const openFile = useCallback((f: OpenedFile) => {
    try {
      const project = migrateProject(JSON.parse(f.text), f.name.replace(/(\.tako)?\.json$/i, ""));
      setLoaded({
        store: createLocalStore(project),
        key: `file:${Date.now()}`,
        source: { kind: "file", name: f.name, handle: f.handle },
        rejected: { current: () => {} },
      });
      setError(null);
    } catch {
      setError(`“${f.name}” isn't a project file this version can read.`);
    }
  }, []);

  if (loaded) {
    return (
      <BoardScreen
        key={loaded.key}
        loaded={loaded}
        onClose={() => {
          loaded.store.close();
          setProjectParam(null);
          setLoaded(null);
        }}
      />
    );
  }
  if (hub === undefined) return <main className="paper open-screen" aria-busy="true" />;
  return <OpenScreen hub={hub} error={error} onOpenFile={openFile} onOpenProject={(id) => hub && void openFromHub(hub, id)} />;
}

function useProjectList(hub: Hub | null) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  useEffect(() => {
    if (!hub) return;
    let live = true;
    const load = () => void hub.list().then((p) => live && setProjects(p), () => {});
    load();
    const off = hub.onEvent((e) => {
      if (e.type !== "project") load();
    });
    return () => {
      live = false;
      off();
    };
  }, [hub]);
  return projects;
}

function OpenScreen({
  hub,
  error,
  onOpenFile,
  onOpenProject,
}: {
  hub: Hub | null;
  error: string | null;
  onOpenFile: (f: OpenedFile) => void;
  onOpenProject: (id: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const projects = useProjectList(hub);

  // Drop a file anywhere to open it.
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) void droppedFile(e.dataTransfer).then((f) => f && onOpenFile(f));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [onOpenFile]);

  return (
    <main className="paper open-screen">
      <div className="open-card">
        <div>
          <p className="label">tako-arm · work board</p>
          <h1>Every task knows which idea it came from</h1>
        </div>
        <p className="dim">
          A project's work items as a board, grouped by the node each one was spawned from. The
          work itself happens elsewhere; this records status, links and the outcome in your own
          words.
        </p>

        {hub && (
          <section className="project-list island" aria-label="Projects">
            <p className="label project-list-head">
              Projects <span className="mono">{hub.dir}</span>
            </p>
            {projects === null ? null : projects.length === 0 ? (
              <p className="dim small project-list-empty">No projects in the hub yet. Make one in the graph tool, or open a file below.</p>
            ) : (
              <ul>
                {projects.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => onOpenProject(p.id)}>
                      <span className="project-title">{named(p.title, "Untitled")}</span>
                      <span className="label">
                        {p.work} work · {p.nodes} nodes
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <div className="row wrap">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            aria-label="Project file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void f.text().then((text) => onOpenFile({ text, name: f.name, handle: null }));
            }}
          />
          <button
            type="button"
            className="btn"
            data-variant={hub ? undefined : "primary"}
            onClick={async () => {
              const picked = await pickFile();
              if (picked === "unsupported") fileRef.current?.click();
              else if (picked) onOpenFile(picked);
            }}
          >
            Open a file…
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const mod = await import("tako/fixtures/sourdough.json");
              onOpenFile({ text: JSON.stringify(mod.default), name: "example-sourdough.json", handle: null });
            }}
          >
            Try an example
          </button>
        </div>
        <p className="dim small">
          {hub
            ? "Hub projects are shared with the other tools and saved as you go. A file you open here stays a file."
            : `No hub found at ${DEFAULT_HUB}. Run “tako” to share projects between tools; until then, open a file${
                canSaveInPlace() ? " and Save writes back to it." : " and Save downloads the updated copy."
              }`}
        </p>
        {error && (
          <p role="alert" className="danger">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

type Selection = { type: "work"; id: string } | { type: "node"; id: string } | null;
type Dispatch = (ops: readonly Op[], coalesceKey?: string) => boolean;

const SYNC_LABEL = { saved: "Saved", saving: "Saving…", offline: "Hub unreachable · changes kept here", local: "" } as const;

function BoardScreen({ loaded, onClose }: { loaded: Loaded; onClose: () => void }) {
  const { store, source } = loaded;
  const snap = useSyncExternalStore(store.subscribe, store.get);
  const project = snap.project;
  const inHub = source.kind === "hub";

  // A file is saved on request, so track what the last save held.
  const [saved, setSaved] = useState<Project>(() => store.get().project);
  const [handle, setHandle] = useState<FileHandle | null>(source.kind === "file" ? source.handle : null);
  const dirty = !inHub && project !== saved;
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [column, setColumn] = useState<Status>("todo");

  useEffect(() => {
    loaded.rejected.current = setNotice;
  }, [loaded]);

  // Every change goes through here, as tako ops: one undo step per call
  // (calls sharing a coalesce key within a second merge, e.g. typing).
  const dispatch = useCallback<Dispatch>(
    (ops, coalesceKey) => {
      if (ops.length === 0) return true;
      try {
        store.dispatch(ops, { coalesceKey });
        return true;
      } catch (e) {
        setNotice(e instanceof OpError ? `Couldn't apply that: ${e.message}` : "Couldn't apply that change.");
        return false;
      }
    },
    [store],
  );

  const step = useCallback(
    (which: "undo" | "redo") => {
      const s = store.get();
      if (which === "undo" ? !s.canUndo : !s.canRedo) return;
      store[which]();
      setNotice(which === "undo" ? "Undone." : "Redone.");
    },
    [store],
  );

  const fileName = source.kind === "file" ? source.name : "";
  const save = useCallback(async () => {
    if (inHub) return; // the hub saves as you go
    const current = store.get().project;
    let text: string;
    try {
      text = serialize(current);
    } catch {
      setNotice("This project no longer validates, so it wasn't saved. Undo the last change and try again.");
      return;
    }
    if (handle) {
      try {
        await writeInPlace(handle, text);
        setSaved(current);
        setNotice(`Saved to ${handle.name}.`);
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setHandle(null); // permission refused or the file moved: fall back
      }
    }
    download(fileName, text);
    setSaved(current);
    setNotice(`Downloaded ${fileName}. Replace your old copy with it.`);
  }, [inHub, store, handle, fileName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "s") {
        e.preventDefault();
        void save();
        return;
      }
      // Text fields keep the browser's own undo.
      const t = e.target as HTMLElement | null;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
      if (mod && !typing && key === "z") {
        e.preventDefault();
        step(e.shiftKey ? "redo" : "undo");
      } else if (mod && !typing && key === "y") {
        e.preventDefault();
        step("redo");
      } else if (e.key === "Escape" && !e.defaultPrevented) {
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, step]);

  const unsent = dirty || snap.sync === "saving" || snap.sync === "offline";
  useEffect(() => {
    if (!unsent) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsent]);

  const board = useMemo(() => buildBoard(project, { kind, query }), [project, kind, query]);
  const kinds = useMemo(() => [...new Set([...board.kinds, ...SUGGESTED_KINDS])], [board.kinds]);
  const filtered = kind !== "" || query.trim() !== "";

  const selectedWork = selection?.type === "work" ? project.work.find((w) => w.id === selection.id) : undefined;
  const contextNodeId = selectedWork?.nodeId ?? (selection?.type === "node" ? selection.id : undefined);
  const context = useMemo(
    () => (contextNodeId ? nodeContext(project, contextNodeId) : null),
    [project, contextNodeId],
  );
  // Something selected that an undo (or delete) removed: close the panel.
  const panelOpen = selection !== null && context !== null && (selection.type === "node" || !!selectedWork);
  useEffect(() => {
    if (selection && !panelOpen) setSelection(null);
  }, [selection, panelOpen]);

  const selectWork = useCallback((id: string) => setSelection({ type: "work", id }), []);
  const selectNode = useCallback((id: string) => setSelection({ type: "node", id }), []);
  const moveTo = useCallback(
    (workId: string, status: Status) => {
      const w = store.get().project.work.find((x) => x.id === workId);
      if (w) dispatch(setStatus(w, status));
    },
    [dispatch, store],
  );
  const add = useCallback(
    (nodeId: string, title: string) => {
      const id = uid();
      if (dispatch(spawnWork(id, nodeId, title, kind || "task"))) setColumn("todo");
    },
    [dispatch, kind],
  );

  const close = () => {
    if (dirty && !window.confirm("Close without saving? Your changes since the last save will be lost.")) return;
    if (snap.sync === "offline" && !window.confirm("The hub is unreachable, so your latest changes haven't been saved. Close anyway?")) return;
    onClose();
  };

  return (
    <div className="app paper" data-panel={panelOpen || undefined}>
      <header className="topbar island">
        <div className="topbar-title">
          <p className="label">{inHub ? "Work board · tako" : `Work board · ${fileName}`}</p>
          <h1 title={project.title}>{named(project.title, "Untitled graph")}</h1>
        </div>
        <div className="row wrap topbar-actions">
          <span className="label save-state" data-dirty={dirty || snap.sync === "offline" || undefined}>
            {inHub ? SYNC_LABEL[snap.sync] : dirty ? "Unsaved changes" : "Saved"}
          </span>
          <button type="button" className="btn" data-variant="ghost" disabled={!snap.canUndo} onClick={() => step("undo")} aria-label="Undo" title="Undo (Ctrl+Z)">
            ↶
          </button>
          <button type="button" className="btn" data-variant="ghost" disabled={!snap.canRedo} onClick={() => step("redo")} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            ↷
          </button>
          {!inHub && (
            <button type="button" className="btn" data-variant="primary" disabled={!dirty} onClick={() => void save()} title="Ctrl+S">
              {handle ? "Save" : "Save (download)"}
            </button>
          )}
          <button type="button" className="btn" onClick={close}>
            Close
          </button>
        </div>
      </header>

      <div className="filters">
        <label className="field-inline">
          <span className="label">Kind</span>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {board.kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline grow">
          <span className="sr-only">Search work items</span>
          <input
            className="input"
            type="search"
            placeholder="Search titles, outcomes, nodes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {board.missingOutcomes > 0 && (
          <span className="flag" title="Finished items whose outcome was never written down">
            {board.missingOutcomes} done without an outcome
          </span>
        )}
      </div>

      {/* Phones show one column at a time. */}
      <fieldset className="segmented column-tabs">
        <legend className="sr-only">Column</legend>
        {STATUSES.map((s) => (
          <label key={s}>
            <input type="radio" name="column" checked={column === s} onChange={() => setColumn(s)} />
            <span>
              {STATUS_LABEL[s]} <b className="mono">{board.totals[s]}</b>
            </span>
          </label>
        ))}
      </fieldset>

      <main className="board" data-column={column}>
        <div className="board-head" aria-hidden="true">
          {STATUSES.map((s) => (
            <div key={s} className="label" data-status={s}>
              {STATUS_LABEL[s]} <b>{board.totals[s]}</b>
            </div>
          ))}
        </div>

        {board.lanes.map((lane) => (
          <LaneView
            key={lane.node.id}
            lane={lane}
            selectedId={selection?.type === "work" ? selection.id : null}
            nodeSelected={selection?.type === "node" && selection.id === lane.node.id}
            onSelect={selectWork}
            onSelectNode={selectNode}
            onMove={moveTo}
            onAdd={add}
          />
        ))}

        {board.lanes.length === 0 && (
          <p className="empty">
            {filtered
              ? "No work items match this filter."
              : project.nodes.length === 0
                ? "This project has no nodes yet. Add some in the graph tool; work is always spawned from a node."
                : "No work yet. Pick a node below and write down the first thing to try."}
          </p>
        )}

        {!filtered && board.idle.length > 0 && (
          <details className="idle" open={board.lanes.length === 0}>
            <summary>
              <span className="label">Nodes with no work</span> <b className="mono">{board.idle.length}</b>
            </summary>
            <ul>
              {board.idle.map((n) => (
                <li key={n.id}>
                  <NodeButton node={n} onClick={() => selectNode(n.id)} />
                  <AddWork nodeId={n.id} onAdd={add} label={`Add work for ${named(n.title, "Untitled")}`} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </main>

      {panelOpen && context && (
        <aside className="panel island" aria-label={selectedWork ? "Work item" : "Node"}>
          <div className="panel-head">
            <span className="label">{selectedWork ? "Work item" : "Node"}</span>
            <button type="button" className="btn" data-variant="ghost" onClick={() => setSelection(null)} aria-label="Close panel">
              ✕
            </button>
          </div>
          <div className="panel-body">
            {selectedWork && (
              <WorkDetail
                key={selectedWork.id}
                project={project}
                work={selectedWork}
                kinds={kinds}
                dispatch={dispatch}
                onDeleted={() => setNotice("Work item deleted. Undo brings it back.")}
                onPromoted={() => setNotice("Promoted: an evidence node was added to the graph.")}
              />
            )}
            <Why project={project} context={context} onSelectNode={selectNode} onSelectWork={selectWork} currentWorkId={selectedWork?.id ?? null} />
          </div>
        </aside>
      )}

      <p className="notice island" role="status" data-shown={notice !== "" || undefined} onAnimationEnd={() => setNotice("")} key={notice}>
        {notice}
      </p>
    </div>
  );
}

function NodeDot({ node }: { node: ProjectNode }) {
  return (
    <span className="node-dot" data-dimmed={node.dimmed || undefined} style={{ background: COLORS[node.color] ?? COLORS.paper }} aria-hidden="true">
      {node.shape === "emoji" && node.emoji}
    </span>
  );
}

function NodeButton({ node, onClick, pressed }: { node: ProjectNode; onClick: () => void; pressed?: boolean }) {
  return (
    <button type="button" className="node-button" onClick={onClick} aria-pressed={pressed} title="Show this node's place in the graph">
      <NodeDot node={node} />
      <span className="node-button-title">{named(node.title, "Untitled")}</span>
      {node.kind && <span className="label">{node.kind}</span>}
    </button>
  );
}

const LaneView = memo(function LaneView({
  lane,
  selectedId,
  nodeSelected,
  onSelect,
  onSelectNode,
  onMove,
  onAdd,
}: {
  lane: Lane;
  selectedId: string | null;
  nodeSelected: boolean;
  onSelect: (id: string) => void;
  onSelectNode: (id: string) => void;
  onMove: (workId: string, status: Status) => void;
  onAdd: (nodeId: string, title: string) => void;
}) {
  const [over, setOver] = useState<Status | null>(null);
  const allow = (e: ReactDragEvent, s: Status) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (over !== s) setOver(s);
  };
  const title = named(lane.node.title, "Untitled");
  return (
    <section className="lane" aria-label={title}>
      <header className="lane-head">
        <NodeButton node={lane.node} onClick={() => onSelectNode(lane.node.id)} pressed={nodeSelected} />
        <span className="rollup" data-rollup={lane.rollup}>
          {ROLLUP_LABEL[lane.rollup]}
        </span>
      </header>
      <div className="lane-cells">
        {STATUSES.map((s) => (
          <div
            key={s}
            className="cell"
            data-status={s}
            data-over={over === s || undefined}
            onDragOver={(e) => allow(e, s)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(DRAG_TYPE);
              setOver(null);
              // A card only moves between columns of its own lane: which
              // idea a task belongs to is changed on purpose, in its panel.
              if (!id || !STATUSES.some((x) => lane.columns[x].some((c) => c.work.id === id))) return;
              e.preventDefault();
              onMove(id, s);
            }}
          >
            <h3 className="sr-only">{STATUS_LABEL[s]}</h3>
            <ul>
              {lane.columns[s].map((card) => (
                <li key={card.work.id}>
                  <CardView card={card} selected={selectedId === card.work.id} onSelect={onSelect} onMove={onMove} />
                </li>
              ))}
            </ul>
            {s === "todo" && <AddWork nodeId={lane.node.id} onAdd={onAdd} label={`Add work for ${title}`} />}
          </div>
        ))}
      </div>
    </section>
  );
});

function CardView({
  card,
  selected,
  onSelect,
  onMove,
}: {
  card: Card;
  selected: boolean;
  onSelect: (id: string) => void;
  onMove: (workId: string, status: Status) => void;
}) {
  const { work } = card;
  const i = STATUSES.indexOf(work.status);
  const prev = STATUSES[i - 1];
  const next = STATUSES[i + 1];
  return (
    <article
      className="card"
      data-selected={selected || undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, work.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <button type="button" className="card-open" onClick={() => onSelect(work.id)} aria-pressed={selected}>
        <span className="card-title">{named(work.title, "Untitled work item")}</span>
        {work.outcome.trim() && <span className="card-outcome">{work.outcome.trim()}</span>}
      </button>
      <div className="card-foot">
        <span className="label">{work.kind || "task"}</span>
        {card.missingOutcome && <span className="flag">No outcome yet</span>}
        {card.promoted.length > 0 && <span className="label mark">◆ Evidence</span>}
        {card.artifacts.length > 0 && (
          <span className="label">
            {card.artifacts.length} artifact{card.artifacts.length === 1 ? "" : "s"}
          </span>
        )}
        {isWebLink(work.link) && (
          <a className="label" href={work.link.trim()} target="_blank" rel="noreferrer noopener">
            Link ↗
          </a>
        )}
        <span className="card-moves">
          {prev && (
            <button type="button" className="chip-btn" onClick={() => onMove(work.id, prev)} aria-label={`Move “${work.title}” back to ${STATUS_LABEL[prev]}`} title={`Back to ${STATUS_LABEL[prev]}`}>
              ←
            </button>
          )}
          {next && (
            <button type="button" className="chip-btn" onClick={() => onMove(work.id, next)} aria-label={`Move “${work.title}” to ${STATUS_LABEL[next]}`} title={`Move to ${STATUS_LABEL[next]}`}>
              →
            </button>
          )}
        </span>
      </div>
    </article>
  );
}

function AddWork({ nodeId, onAdd, label }: { nodeId: string; onAdd: (nodeId: string, title: string) => void; label: string }) {
  const [title, setTitle] = useState("");
  return (
    <form
      className="add-work"
      onSubmit={(e) => {
        e.preventDefault();
        const t = title.trim();
        if (!t) return;
        onAdd(nodeId, t);
        setTitle("");
      }}
    >
      <input className="input" aria-label={label} placeholder="+ Add work…" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      {title.trim() && (
        <button type="submit" className="btn">
          Add
        </button>
      )}
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function WorkDetail({
  project,
  work,
  kinds,
  dispatch,
  onDeleted,
  onPromoted,
}: {
  project: Project;
  work: Work;
  kinds: string[];
  dispatch: Dispatch;
  onDeleted: () => void;
  onPromoted: () => void;
}) {
  const card = useMemo(() => cardOf(project, work), [project, work]);
  const patch = (p: Partial<Omit<Work, "id">>, field: string) =>
    dispatch([{ type: "update_work", id: work.id, patch: p }], `work:${work.id}:${field}`);

  return (
    <div className="detail">
      <Field label="Title">
        <textarea className="input title-input" rows={2} maxLength={200} value={work.title} onChange={(e) => patch({ title: e.target.value.replace(/\n/g, " ") }, "title")} />
      </Field>

      <div className="row">
        <Field label="Kind">
          <input className="input" list="work-kinds" maxLength={40} value={work.kind} onChange={(e) => patch({ kind: e.target.value }, "kind")} />
          <datalist id="work-kinds">
            {kinds.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </Field>
        <fieldset className="field">
          <legend className="label">Status</legend>
          <div className="segmented">
            {STATUSES.map((s) => (
              <label key={s}>
                <input type="radio" name={`status-${work.id}`} checked={work.status === s} onChange={() => dispatch(setStatus(work, s))} />
                <span>{STATUS_LABEL[s]}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <Field label="Link" hint="Where the work lives: a repo, a notebook, a paper, a ticket.">
        <span className="row">
          <input className="input grow" type="url" inputMode="url" placeholder="https://…" maxLength={2000} value={work.link} onChange={(e) => patch({ link: e.target.value }, "link")} />
          {isWebLink(work.link) && (
            <a className="btn" href={work.link.trim()} target="_blank" rel="noreferrer noopener">
              Open ↗
            </a>
          )}
        </span>
      </Field>

      <Field
        label="Outcome"
        hint={card.missingOutcome ? "Done, but nothing is written down yet. What did it show?" : "In your own words. A slide quotes this exactly once the item is done."}
      >
        <textarea
          className="input"
          rows={4}
          maxLength={4000}
          data-flag={card.missingOutcome || undefined}
          value={work.outcome}
          onChange={(e) => dispatch([{ type: "attach_outcome", workId: work.id, outcome: e.target.value }], `work:${work.id}:outcome`)}
        />
      </Field>

      <Artifacts card={card} dispatch={dispatch} />
      <Promote project={project} card={card} dispatch={dispatch} onPromoted={onPromoted} />

      <button
        type="button"
        className="btn danger-btn"
        onClick={() => {
          if (dispatch([{ type: "remove_work", id: work.id }])) onDeleted();
        }}
      >
        Delete work item
      </button>
    </div>
  );
}

function Artifacts({ card, dispatch }: { card: Card; dispatch: Dispatch }) {
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  return (
    <section className="section">
      <h3 className="label">Artifacts</h3>
      {card.artifacts.length > 0 && (
        <ul className="plain-list">
          {card.artifacts.map((a) => (
            <li key={a.id} className="row">
              <span className="grow">
                {isWebLink(a.link) ? (
                  <a href={a.link.trim()} target="_blank" rel="noreferrer noopener">
                    {named(a.title, "Artifact")} ↗
                  </a>
                ) : (
                  named(a.title, "Artifact")
                )}{" "}
                <span className="label">{a.kind}</span>
              </span>
              <button type="button" className="chip-btn" onClick={() => dispatch([{ type: "remove_artifact", id: a.id }])} aria-label={`Remove artifact “${a.title}”`}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          if (dispatch(addArtifact(uid(), card.work, title.trim(), link.trim()))) {
            setTitle("");
            setLink("");
          }
        }}
      >
        <input className="input grow" aria-label="Artifact title" placeholder="A plot, a table, a PR…" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="input grow" aria-label="Artifact link" type="url" placeholder="https://…" maxLength={2000} value={link} onChange={(e) => setLink(e.target.value)} />
        <button type="submit" className="btn" disabled={!title.trim()}>
          Add
        </button>
      </form>
    </section>
  );
}

/** Promotion: the one step that moves a conclusion from the work log onto
 * the graph. The finding is typed by the author; it starts empty and is
 * never suggested. */
function Promote({ project, card, dispatch, onPromoted }: { project: Project; card: Card; dispatch: Dispatch; onPromoted: () => void }) {
  const { work } = card;
  const [finding, setFinding] = useState("");
  const [relation, setRelation] = useState("supports");
  const [custom, setCustom] = useState("");
  const node = project.nodes.find((n) => n.id === work.nodeId);
  const hasOutcome = work.outcome.trim() !== "";
  const label = relation === "custom" ? custom.trim() : relation;
  return (
    <section className="section">
      <h3 className="label">Evidence on the graph</h3>
      {card.promoted.length > 0 && (
        <ul className="plain-list">
          {card.promoted.map((n) => (
            <li key={n.id}>
              <span className="mark">◆</span> {named(n.title, "Evidence")}
            </li>
          ))}
        </ul>
      )}
      {!hasOutcome ? (
        <p className="hint">Write the outcome first. Promoting it then adds an evidence node beside “{named(node?.title ?? "", "Untitled")}”.</p>
      ) : (
        <details className="promote">
          <summary>{card.promoted.length ? "Promote another finding" : "Promote to evidence…"}</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!finding.trim()) return;
              try {
                const ops = promoteWork(project, work.id, { nodeId: uid(), edgeId: uid(), finding, relation: label });
                if (dispatch(ops)) {
                  setFinding("");
                  onPromoted();
                }
              } catch {
                /* the form already prevents an empty finding */
              }
            }}
          >
            <Field label="The finding, in your words" hint="Becomes the evidence node's title. The outcome above becomes its notes.">
              <input className="input" maxLength={FINDING_MAX} value={finding} onChange={(e) => setFinding(e.target.value)} />
            </Field>
            <fieldset className="field">
              <legend className="label">What it does to “{named(node?.title ?? "", "Untitled")}”</legend>
              <div className="segmented">
                {["supports", "weakens", "custom"].map((r) => (
                  <label key={r}>
                    <input type="radio" name={`relation-${work.id}`} checked={relation === r} onChange={() => setRelation(r)} />
                    <span>{r === "custom" ? "Other…" : r}</span>
                  </label>
                ))}
              </div>
              {relation === "custom" && (
                <input className="input" aria-label="Edge label" placeholder="Edge label" maxLength={120} value={custom} onChange={(e) => setCustom(e.target.value)} />
              )}
            </fieldset>
            <button type="submit" className="btn" data-variant="primary" disabled={!finding.trim()}>
              Add evidence node
            </button>
          </form>
        </details>
      )}
    </section>
  );
}

/** Why this task exists: the node it came from and that node's place in
 * the graph. */
function Why({
  project,
  context,
  onSelectNode,
  onSelectWork,
  currentWorkId,
}: {
  project: Project;
  context: NodeContext;
  onSelectNode: (id: string) => void;
  onSelectWork: (id: string) => void;
  currentWorkId: string | null;
}) {
  const { node, connections, paths, work } = context;
  const others = work.filter((w) => w.id !== currentWorkId);
  return (
    <section className="section why">
      <h3 className="label">{currentWorkId ? "Why this exists" : "Place in the graph"}</h3>
      <div className="why-node">
        <NodeDot node={node} />
        <div>
          <p className="why-title">{named(node.title, "Untitled")}</p>
          {node.subtitle.trim() && <p className="dim small">{node.subtitle.trim()}</p>}
        </div>
        <span className="rollup" data-rollup={context.rollup}>
          {ROLLUP_LABEL[context.rollup]}
        </span>
      </div>
      {node.body.trim() && <p className="why-notes">{node.body.trim()}</p>}
      {node.provenance && (
        <p className="dim small">
          From {node.provenance.source}
          {node.provenance.ref && `: ${node.provenance.ref}`}
        </p>
      )}

      <MiniMap project={project} focusId={node.id} onSelectNode={onSelectNode} />

      {connections.length > 0 ? (
        <ul className="plain-list connections">
          {connections.map((c) => (
            <li key={c.edge.id}>
              <span className="mono dim">{c.direction === "out" ? "→" : "←"}</span>
              <span className="edge-label">{c.edge.label.trim() || "connected to"}</span>
              <button type="button" className="link-btn" onClick={() => onSelectNode(c.other.id)}>
                {named(c.other.title, "Untitled")}
              </button>
              {c.other.kind && <span className="label">{c.other.kind}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="flag-text">Not connected to anything: an orphan node.</p>
      )}

      {paths.length > 0 && (
        <p className="dim small">
          On {paths.length === 1 ? "the path" : "paths"}{" "}
          {paths.map((p, i) => (
            <span key={p.narrative.id}>
              {i > 0 && ", "}“{named(p.narrative.name, "Untitled path")}” (stop {p.stop} of {p.of})
            </span>
          ))}
          .
        </p>
      )}

      {others.length > 0 && (
        <>
          <h3 className="label">{currentWorkId ? "Other work on this node" : "Work on this node"}</h3>
          <ul className="plain-list">
            {others.map((w) => (
              <li key={w.id} className="row">
                <button type="button" className="link-btn grow" onClick={() => onSelectWork(w.id)}>
                  {named(w.title, "Untitled work item")}
                </button>
                <span className="label">{STATUS_LABEL[w.status]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The whole graph, small, with one node picked out: where the idea sits. */
const MiniMap = memo(function MiniMap({ project, focusId, onSelectNode }: { project: Project; focusId: string; onSelectNode: (id: string) => void }) {
  const { nodes, edges } = project;
  if (nodes.length < 2) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const near = new Set<string>();
  for (const e of edges) {
    if (e.from === focusId) near.add(e.to);
    else if (e.to === focusId) near.add(e.from);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const r = NODE_SIZE[n.size] / 2;
    x0 = Math.min(x0, n.x - r);
    y0 = Math.min(y0, n.y - r);
    x1 = Math.max(x1, n.x + r);
    y1 = Math.max(y1, n.y + r);
  }
  const pad = 24;
  // Hairlines stay about a pixel whatever the graph's extent.
  const unit = Math.max(x1 - x0, (y1 - y0) * 1.6) / 300;
  return (
    <svg className="minimap" viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + pad * 2} ${y1 - y0 + pad * 2}`} role="group" aria-label="Map of the graph">
      {edges.map((e) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        const touches = e.from === focusId || e.to === focusId;
        return (
          <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="minimap-edge" data-near={touches || undefined} strokeWidth={unit * (touches ? 1.6 : 1)} strokeDasharray={e.style === "dashed" ? `${unit * 4} ${unit * 3}` : undefined} />
        );
      })}
      {nodes.map((n) => {
        const focus = n.id === focusId;
        return (
          <circle
            key={n.id}
            cx={n.x}
            cy={n.y}
            r={NODE_SIZE[n.size] / 2}
            className="minimap-node"
            data-focus={focus || undefined}
            data-near={near.has(n.id) || undefined}
            strokeWidth={unit * (focus ? 2.5 : 1)}
            onClick={focus ? undefined : () => onSelectNode(n.id)}
          >
            <title>{named(n.title, "Untitled")}</title>
          </circle>
        );
      })}
    </svg>
  );
});
