/**
 * cairn attention triage UI — vanilla JS module.
 *
 * No framework, no build step. Fetches `/api/state` on load, renders
 * draft cards + cluster list, dispatches accept/reject/edit/merge to
 * the JSON API. Polls heartbeat every 5s while the page is open so the
 * server's idle timer doesn't shut us down mid-triage.
 */

const HEARTBEAT_MS = 5_000;

const state = {
  drafts: [],
  clusters: [],
  counts: {},
  selectedClusterIdx: null,
  focusedDraftIdx: 0,
  editing: null,
};

/* ── api helpers ───────────────────────────────────────────────── */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

async function refresh() {
  const data = await api("/api/state");
  state.drafts = data.drafts ?? [];
  state.clusters = data.clusters ?? [];
  state.counts = data.counts ?? {};
  if (state.focusedDraftIdx >= state.drafts.length) {
    state.focusedDraftIdx = Math.max(0, state.drafts.length - 1);
  }
  render();
}

/* ── rendering ─────────────────────────────────────────────────── */

function render() {
  renderCounters();
  renderClusters();
  renderDrafts();
}

function renderCounters() {
  const c = state.counts;
  document.getElementById("counters").innerHTML = `
    <span class="pill"><span class="num">${state.drafts.length}</span> remaining</span>
    <span class="pill"><span class="num">${c.accepted ?? 0}</span> accepted</span>
    <span class="pill"><span class="num">${c.rejected ?? 0}</span> rejected</span>
    <span class="pill"><span class="num">${c.merged ?? 0}</span> merged</span>
  `;
}

function renderClusters() {
  const list = document.getElementById("cluster-list");
  if (state.clusters.length === 0) {
    list.innerHTML = `<div class="empty" style="padding:8px 0">no duplicate clusters</div>`;
    return;
  }
  list.innerHTML = state.clusters
    .map(
      (c, i) => `
    <div class="cluster-item ${state.selectedClusterIdx === i ? "active" : ""}" data-idx="${i}">
      <div class="row">
        <strong>${c.drafts.length} drafts</strong>
        <span class="badge ${c.tier}">${c.tier}</span>
      </div>
      <div class="meta">avg sim ${c.averageSimilarity.toFixed(2)} · merge keeps ${c.drafts[0].id}</div>
    </div>
  `,
    )
    .join("");
  list.querySelectorAll(".cluster-item").forEach((el) =>
    el.addEventListener("click", () => {
      state.selectedClusterIdx =
        state.selectedClusterIdx === Number(el.dataset.idx)
          ? null
          : Number(el.dataset.idx);
      render();
    }),
  );
}

function renderDrafts() {
  const pane = document.getElementById("draft-list");
  const empty = document.getElementById("empty-state");
  const title = document.getElementById("pane-title");

  if (state.selectedClusterIdx !== null) {
    const cluster = state.clusters[state.selectedClusterIdx];
    title.textContent = `cluster · ${cluster.drafts.length} drafts · ${cluster.tier}`;
    if (cluster.drafts.length === 0) {
      pane.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    const survivor = cluster.drafts[0];
    pane.innerHTML =
      `<div class="draft-card cluster-card">
        <div class="meta">
          <span class="chip">survivor: ${survivor.id}</span>
          <span class="chip">${cluster.drafts.length - 1} duplicates rejected on merge</span>
        </div>
        <div class="actions-row">
          <button class="primary" id="cluster-merge">merge cluster (keep ${survivor.id})</button>
          <button class="ghost" id="cluster-cancel">cancel</button>
        </div>
      </div>` +
      cluster.drafts
        .map((d, idx) => renderDraftCardForCluster(d, idx === 0))
        .join("");
    document
      .getElementById("cluster-merge")
      .addEventListener("click", () => mergeCluster());
    document
      .getElementById("cluster-cancel")
      .addEventListener("click", () => {
        state.selectedClusterIdx = null;
        render();
      });
    return;
  }

  title.textContent = `drafts · ${state.drafts.length}`;
  if (state.drafts.length === 0) {
    pane.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  pane.innerHTML = state.drafts
    .map((d, i) => renderDraftCard(d, i === state.focusedDraftIdx))
    .join("");
  attachDraftHandlers();
  scrollFocusedIntoView();
}

function renderDraftCard(d, focused) {
  const editingThis = state.editing?.id === d.id;
  return `
    <article class="draft-card ${focused ? "focus" : ""}" data-id="${d.id}">
      <div class="title">
        <span class="id">${d.id}</span>
        <span>${escapeHtml(d.title)}</span>
      </div>
      <div class="meta">
        ${d.source ? `<span class="chip">${d.source}</span>` : ""}
        ${d.sourceFile ? `<span class="chip">${escapeHtml(d.sourceFile)}</span>` : ""}
        ${d.confidence ? `<span class="chip">${d.confidence}</span>` : ""}
      </div>
      ${editingThis ? renderEditor(d) : renderBody(d)}
      ${editingThis ? "" : `
      <div class="actions-row">
        <button class="primary" data-action="accept">accept</button>
        <button class="danger" data-action="reject">reject</button>
        <button class="ghost" data-action="edit">edit</button>
      </div>`}
    </article>
  `;
}

function renderDraftCardForCluster(d, isSurvivor) {
  return `
    <article class="draft-card cluster-card">
      <div class="title">
        <span class="id">${d.id}</span>
        <span>${escapeHtml(d.title)}${isSurvivor ? " · survivor" : ""}</span>
      </div>
      <div class="meta">
        ${d.sourceFile ? `<span class="chip">${escapeHtml(d.sourceFile)}</span>` : ""}
      </div>
    </article>
  `;
}

function renderBody(d) {
  const text = d.proposedRationale ?? d.body ?? "";
  return `<div class="body">${escapeHtml(text)}</div>`;
}

function renderEditor(d) {
  const titleVal = state.editing?.title ?? d.title;
  const bodyVal = state.editing?.body_markdown ?? d.proposedRationale ?? d.body ?? "";
  return `
    <div class="editor">
      <input type="text" id="edit-title" value="${escapeAttr(titleVal)}" placeholder="title" />
      <textarea id="edit-body" placeholder="rationale / body markdown">${escapeHtml(bodyVal)}</textarea>
      <div class="actions-row">
        <button class="primary" data-action="save-edit">save</button>
        <button class="ghost" data-action="cancel-edit">cancel</button>
      </div>
    </div>
  `;
}

function attachDraftHandlers() {
  document.querySelectorAll(".draft-card[data-id]").forEach((el) => {
    const id = el.dataset.id;
    el.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const action = btn.dataset.action;
        if (action === "accept") return acceptDraft(id);
        if (action === "reject") return rejectDraft(id);
        if (action === "edit") {
          state.editing = { id };
          render();
          return;
        }
        if (action === "save-edit") return saveEdit(id);
        if (action === "cancel-edit") {
          state.editing = null;
          render();
          return;
        }
      });
    });
    el.addEventListener("click", () => {
      const idx = state.drafts.findIndex((d) => d.id === id);
      if (idx >= 0) {
        state.focusedDraftIdx = idx;
        render();
      }
    });
  });
}

function scrollFocusedIntoView() {
  const focused = document.querySelector(".draft-card.focus");
  if (focused) {
    focused.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

/* ── actions ───────────────────────────────────────────────────── */

async function acceptDraft(id) {
  setStatus(`accepting ${id}…`);
  const r = await api(`/api/draft/${id}/accept`, { method: "POST" });
  if (!r.ok) {
    setStatus(`accept failed: ${r.error ?? "unknown"}`);
    return;
  }
  setStatus(`accepted ${id}`);
  await refresh();
}

async function rejectDraft(id) {
  setStatus(`rejecting ${id}…`);
  const r = await api(`/api/draft/${id}/reject`, { method: "POST" });
  if (!r.ok) {
    setStatus(`reject failed`);
    return;
  }
  setStatus(`rejected ${id}`);
  await refresh();
}

async function saveEdit(id) {
  const title = document.getElementById("edit-title").value;
  const body = document.getElementById("edit-body").value;
  setStatus(`saving ${id}…`);
  const r = await api(`/api/draft/${id}/edit`, {
    method: "POST",
    body: { title, body_markdown: body },
  });
  if (!r.ok) {
    setStatus(`edit failed: ${r.error ?? "unknown"}`);
    return;
  }
  state.editing = null;
  setStatus(`saved ${id}`);
  await refresh();
}

async function mergeCluster() {
  if (state.selectedClusterIdx === null) return;
  const cluster = state.clusters[state.selectedClusterIdx];
  const survivor = cluster.drafts[0].id;
  const members = cluster.drafts.map((d) => d.id);
  setStatus(`merging cluster, keeping ${survivor}…`);
  const r = await api("/api/cluster/merge", {
    method: "POST",
    body: { survivor_id: survivor, member_ids: members },
  });
  if (!r.ok) {
    setStatus(`merge failed`);
    return;
  }
  setStatus(`merged — kept ${survivor}, rejected ${r.rejected}`);
  state.selectedClusterIdx = null;
  await refresh();
}

async function bulkAcceptHigh() {
  setStatus("bulk-accepting high-confidence drafts…");
  const r = await api("/api/bulk-accept", {
    method: "POST",
    body: { threshold: "high" },
  });
  if (r.ok) {
    setStatus(`bulk-accepted ${r.decsAccepted} drafts`);
  } else {
    setStatus(`bulk-accept failed`);
  }
  await refresh();
}

async function done() {
  setStatus("finalizing…");
  await api("/api/done", { method: "POST" });
  setStatus("done. Claude Code session resuming.");
  document.body.style.opacity = "0.5";
}

/* ── keyboard ──────────────────────────────────────────────────── */

document.addEventListener("keydown", (ev) => {
  if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
  const key = ev.key;
  if (key === "j") {
    state.focusedDraftIdx = Math.min(
      state.drafts.length - 1,
      state.focusedDraftIdx + 1,
    );
    render();
  } else if (key === "k") {
    state.focusedDraftIdx = Math.max(0, state.focusedDraftIdx - 1);
    render();
  } else if (key === "a") {
    const d = state.drafts[state.focusedDraftIdx];
    if (d) acceptDraft(d.id);
  } else if (key === "r") {
    const d = state.drafts[state.focusedDraftIdx];
    if (d) rejectDraft(d.id);
  } else if (key === "e") {
    const d = state.drafts[state.focusedDraftIdx];
    if (d) {
      state.editing = { id: d.id };
      render();
    }
  } else if (key === "m") {
    if (state.selectedClusterIdx !== null) mergeCluster();
  } else if (key === "?") {
    document.querySelector(".right").classList.toggle("hidden");
  }
});

/* ── helpers ───────────────────────────────────────────────────── */

function setStatus(msg) {
  document.getElementById("status-line").textContent = msg;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/* ── boot ──────────────────────────────────────────────────────── */

document.getElementById("done").addEventListener("click", done);
document.getElementById("bulk-high").addEventListener("click", bulkAcceptHigh);

setInterval(() => {
  fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
}, HEARTBEAT_MS);

refresh();
