// ---------- Tabs ----------

const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
    panels.forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

// ---------- Credits balance (top right) ----------

async function loadCredits() {
  const pill = document.getElementById("credits-pill");
  const valueEl = document.getElementById("credits-value");
  try {
    const res = await fetch("/api/credits");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load credits");
    const credits = data.credits;
    valueEl.textContent = typeof credits === "number" ? credits.toLocaleString() : "—";
    pill.classList.remove("loading");
    pill.classList.toggle("low", typeof credits === "number" && credits < 20);
  } catch (e) {
    valueEl.textContent = "—";
    pill.classList.remove("loading");
    pill.title = "Could not load kie.ai credit balance: " + e.message;
  }
}

loadCredits();
setInterval(loadCredits, 60000);

// ---------- Shared helpers ----------

let lastGeneratedImageUrl = null;

function setStatus(el, text, kind) {
  el.textContent = text || "";
  el.className = "status-line" + (kind ? " " + kind : "");
}

async function uploadFile(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data.url;
}

function wireDrop(dropId, fileInputId, previewId, onFile) {
  const drop = document.getElementById(dropId);
  const input = document.getElementById(fileInputId);
  const preview = document.getElementById(previewId);

  drop.addEventListener("click", () => input.click());

  input.addEventListener("change", () => {
    if (input.files[0]) handleFile(input.files[0]);
  });

  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.borderColor = "var(--accent)"; });
  drop.addEventListener("dragleave", () => { drop.style.borderColor = ""; });
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.style.borderColor = "";
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  function handleFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      preview.src = reader.result;
      preview.hidden = false;
      drop.querySelector(".drop-text").style.display = "none";
    };
    reader.readAsDataURL(file);
    onFile(file);
  }
}

async function pollTask(taskId, { onTick, onDone, onError }) {
  const maxAttempts = 90; // ~ up to 4-5 min at 3s interval, generous for video
  let attempts = 0;

  const interval = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch(`/api/status/${taskId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Status check failed");

      if (onTick) onTick(data.state, attempts);

      if (data.state === "success") {
        clearInterval(interval);
        onDone(data.urls || []);
      } else if (data.state === "fail") {
        clearInterval(interval);
        onError(data.error || "Generation failed");
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        onError("Timed out waiting for the result. The task may still finish — check back with the task ID: " + taskId);
      }
    } catch (e) {
      clearInterval(interval);
      onError(e.message);
    }
  }, 3000);
}

// ---------- Image generation ----------

let imageRefUrl = null;
let selectedImageCharUrls = [];

wireDrop("image-ref-drop", "image-ref-file", "image-ref-preview", async (file) => {
  setStatus(document.getElementById("image-status"), "Uploading reference image…");
  try {
    imageRefUrl = await uploadFile(file);
    setStatus(document.getElementById("image-status"), "Reference image ready.", "ok");
  } catch (e) {
    setStatus(document.getElementById("image-status"), e.message, "err");
  }
});

document.getElementById("image-run").addEventListener("click", async () => {
  const btn = document.getElementById("image-run");
  const statusEl = document.getElementById("image-status");
  const prompt = document.getElementById("image-prompt").value.trim();
  const aspect = document.getElementById("image-aspect").value;

  if (!prompt) { setStatus(statusEl, "Enter a prompt first.", "err"); return; }

  document.getElementById("image-result-empty").hidden = true;
  document.getElementById("image-result-img").hidden = true;
  document.getElementById("image-download").hidden = true;
  document.getElementById("image-result-loading").hidden = false;
  document.getElementById("image-loading-text").textContent = "Submitting task…";

  btn.disabled = true;
  setStatus(statusEl, "");

  try {
    const res = await fetch("/api/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        aspect_ratio: aspect,
        image_urls: [...selectedImageCharUrls, ...(imageRefUrl ? [imageRefUrl] : [])],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");

    document.getElementById("image-loading-text").textContent = "Generating…";

    pollTask(data.task_id, {
      onDone: (urls) => {
        document.getElementById("image-result-loading").hidden = true;
        btn.disabled = false;
        if (!urls.length) { setStatus(statusEl, "Done, but no image URL was returned.", "err"); return; }
        const url = urls[0];
        lastGeneratedImageUrl = url;
        const img = document.getElementById("image-result-img");
        img.src = url;
        img.hidden = false;
        const promptText = document.getElementById("image-prompt").value.trim();
        img.onclick = () => openLightbox([{ url, kind: "image", prompt: promptText }], 0);
        const dl = document.getElementById("image-download");
        dl.href = url;
        dl.hidden = false;
        const expandBtn = document.getElementById("image-expand");
        expandBtn.hidden = false;
        expandBtn.onclick = () => openLightbox([{ url, kind: "image", prompt: promptText }], 0);
        document.getElementById("video-use-last").hidden = false;
        document.getElementById("bulk-video-use-last").hidden = false;
        setStatus(statusEl, "Image ready.", "ok");
        loadCredits();
      },
      onError: (msg) => {
        document.getElementById("image-result-loading").hidden = true;
        document.getElementById("image-result-empty").hidden = false;
        btn.disabled = false;
        setStatus(statusEl, msg, "err");
      },
    });
  } catch (e) {
    document.getElementById("image-result-loading").hidden = true;
    document.getElementById("image-result-empty").hidden = false;
    btn.disabled = false;
    setStatus(statusEl, e.message, "err");
  }
});

// ---------- Video generation ----------

let videoRefUrl = null;
let selectedVideoCharUrl = null;

wireDrop("video-ref-drop", "video-ref-file", "video-ref-preview", async (file) => {
  setStatus(document.getElementById("video-status"), "Uploading source image…");
  try {
    videoRefUrl = await uploadFile(file);
    setStatus(document.getElementById("video-status"), "Source image ready.", "ok");
  } catch (e) {
    setStatus(document.getElementById("video-status"), e.message, "err");
  }
});

document.getElementById("video-use-last").addEventListener("click", () => {
  if (!lastGeneratedImageUrl) return;
  videoRefUrl = lastGeneratedImageUrl;
  const preview = document.getElementById("video-ref-preview");
  preview.src = lastGeneratedImageUrl;
  preview.hidden = false;
  document.querySelector("#video-ref-drop .drop-text").style.display = "none";
  setStatus(document.getElementById("video-status"), "Using last generated image.", "ok");
});

document.getElementById("bulk-video-use-last").addEventListener("click", () => {
  if (!lastGeneratedImageUrl) return;
  bulkVideoImageUrls = [lastGeneratedImageUrl];
  renderBulkVideoThumbs([lastGeneratedImageUrl]);
  setStatus(document.getElementById("bulk-video-status"), "Using last generated image for all prompts.", "ok");
});

document.getElementById("video-run").addEventListener("click", async () => {
  const btn = document.getElementById("video-run");
  const statusEl = document.getElementById("video-status");
  const prompt = document.getElementById("video-prompt").value.trim();
  const aspect = document.getElementById("video-aspect").value;
  const duration = parseInt(document.getElementById("video-duration").value, 10) || 8;

  if (!prompt) { setStatus(statusEl, "Enter a prompt first.", "err"); return; }
  if (!videoRefUrl && !selectedVideoCharUrl) { setStatus(statusEl, "Upload a source image first — this model animates a still image.", "err"); return; }

  document.getElementById("video-result-empty").hidden = true;
  document.getElementById("video-result-video").hidden = true;
  document.getElementById("video-download").hidden = true;
  document.getElementById("video-result-loading").hidden = false;
  document.getElementById("video-loading-text").textContent = "Submitting task…";

  btn.disabled = true;
  setStatus(statusEl, "");

  try {
    const res = await fetch("/api/video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        image_url: selectedVideoCharUrl || videoRefUrl,
        aspect_ratio: aspect,
        duration,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");

    document.getElementById("video-loading-text").textContent = "Generating… this can take a minute or two";

    pollTask(data.task_id, {
      onDone: (urls) => {
        document.getElementById("video-result-loading").hidden = true;
        btn.disabled = false;
        if (!urls.length) { setStatus(statusEl, "Done, but no video URL was returned.", "err"); return; }
        const url = urls[0];
        const vid = document.getElementById("video-result-video");
        vid.src = url;
        vid.hidden = false;
        const promptText = document.getElementById("video-prompt").value.trim();
        const dl = document.getElementById("video-download");
        dl.href = url;
        dl.hidden = false;
        const expandBtn = document.getElementById("video-expand");
        expandBtn.hidden = false;
        expandBtn.onclick = () => openLightbox([{ url, kind: "video", prompt: promptText }], 0);
        setStatus(statusEl, "Video ready.", "ok");
        loadCredits();
      },
      onError: (msg) => {
        document.getElementById("video-result-loading").hidden = true;
        document.getElementById("video-result-empty").hidden = false;
        btn.disabled = false;
        setStatus(statusEl, msg, "err");
      },
    });
  } catch (e) {
    document.getElementById("video-result-loading").hidden = true;
    document.getElementById("video-result-empty").hidden = false;
    btn.disabled = false;
    setStatus(statusEl, e.message, "err");
  }
});


// ============================================================
// Bulk generation (shared helpers + image/video specific wiring)
// ============================================================

function countPrompts(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).length;
}

function wireLiveCount(textareaId, countId, runBtnId) {
  const el = document.getElementById(textareaId);
  const countEl = document.getElementById(countId);
  const runBtn = document.getElementById(runBtnId);
  el.addEventListener("input", () => {
    const n = countPrompts(el.value);
    countEl.textContent = `${n} prompt${n === 1 ? "" : "s"}` + (n > 150 ? " (max 150 — extra lines ignored)" : "");
    countEl.style.color = n > 150 ? "var(--danger)" : "";
    if (runBtn && !runBtn.dataset.userLocked) {
      runBtn.disabled = n === 0;
      runBtn.textContent = n === 0 ? "Enter prompts to generate" : "Generate all";
    }
  });
}

wireLiveCount("bulk-image-prompts", "bulk-image-count", "bulk-image-run");
wireLiveCount("bulk-video-prompts", "bulk-video-count", "bulk-video-run");

// ---------- Pill group helper (single-select buttons with data-value) ----------

function wirePillGroup(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.addEventListener("click", (e) => {
    const btn = e.target.closest(".pill");
    if (!btn || btn.disabled || !group.contains(btn)) return;
    group.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    group.dataset.value = btn.dataset.value;
  });
}

wirePillGroup("bulk-image-aspect-pills");
wirePillGroup("bulk-video-aspect-pills");
wirePillGroup("bulk-image-style-pills");

document.getElementById("bulk-image-style-clear").addEventListener("click", () => {
  const group = document.getElementById("bulk-image-style-pills");
  group.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
  const noneBtn = group.querySelector('.pill[data-value=""]');
  if (noneBtn) noneBtn.classList.add("active");
  group.dataset.value = "";
});

document.getElementById("bulk-image-style-add").addEventListener("click", () => {
  const custom = window.prompt("Describe the style to prepend to every prompt (e.g. 'Watercolor illustration, soft pastel palette,'):");
  if (!custom) return;
  const group = document.getElementById("bulk-image-style-pills");
  const btn = document.createElement("button");
  btn.className = "pill";
  btn.dataset.value = custom.trim().replace(/,?\s*$/, ", ");
  btn.textContent = custom.length > 18 ? custom.slice(0, 16) + "…" : custom;
  btn.title = custom;
  group.appendChild(btn);
  group.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
  btn.classList.add("active");
  group.dataset.value = btn.dataset.value;
});

// ---------- Timing helpers ----------

function fmtDuration(secs) {
  secs = Math.max(0, Math.round(secs));
  if (secs < 60) return secs + "s";
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}m ${s}s`;
}

// ---------- Queue list rendering ----------

function renderQueue(queueId, jobs) {
  const list = document.getElementById(queueId);
  list.innerHTML = "";
  jobs.forEach((job) => {
    const item = document.createElement("div");
    item.className = "queue-item";

    const top = document.createElement("div");
    top.className = "queue-item-top";

    const scene = document.createElement("span");
    scene.className = "queue-scene";
    scene.textContent = `Scene ${String(job.index + 1).padStart(3, "0")}`;

    const state = document.createElement("span");
    state.className = "queue-state " + job.state;
    state.textContent = job.state;

    top.appendChild(scene);
    top.appendChild(state);

    const prompt = document.createElement("div");
    prompt.className = "queue-prompt";
    prompt.textContent = job.prompt;
    if (job.state === "fail" && job.error) prompt.title = job.error;

    item.appendChild(top);
    item.appendChild(prompt);
    list.appendChild(item);
  });
}

// ---------- Media grid rendering ----------

function renderBulkGrid(gridId, jobs, kind) {
  const grid = document.getElementById(gridId);
  grid.innerHTML = "";

  // Build the gallery of successful items once so the lightbox can page through them.
  const successItems = jobs
    .filter((j) => j.state === "success" && j.url)
    .map((j) => ({ url: j.url, kind, prompt: j.prompt }));

  jobs.forEach((job) => {
    if (job.state === "queued") return; // not started yet, no card needed in gallery
    const card = document.createElement("div");
    card.className = "bulk-card";

    const mediaWrap = document.createElement("div");
    mediaWrap.className = "bulk-card-media-wrap";

    if (job.state === "success" && job.url) {
      if (kind === "image") {
        const img = document.createElement("img");
        img.src = job.url;
        img.addEventListener("click", () => {
          const idx = successItems.findIndex((it) => it.url === job.url);
          openLightbox(successItems, Math.max(0, idx));
        });
        mediaWrap.appendChild(img);
      } else {
        const vid = document.createElement("video");
        vid.src = job.url;
        vid.controls = true;
        vid.muted = true;
        mediaWrap.appendChild(vid);

        const expandBtn = document.createElement("button");
        expandBtn.className = "bulk-card-expand";
        expandBtn.title = "Preview full size";
        expandBtn.textContent = "⛶";
        expandBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const idx = successItems.findIndex((it) => it.url === job.url);
          openLightbox(successItems, Math.max(0, idx));
        });
        mediaWrap.appendChild(expandBtn);
      }
    } else {
      const status = document.createElement("div");
      status.className = "bulk-card-status " + job.state;
      status.style.padding = "20px 8px";
      status.textContent = job.state === "fail" ? "Failed" : job.state;
      mediaWrap.appendChild(status);
    }

    const prompt = document.createElement("div");
    prompt.className = "bulk-card-prompt";
    prompt.textContent = job.prompt;

    const footer = document.createElement("div");
    footer.className = "bulk-card-status " + job.state;
    footer.style.padding = "6px 8px";
    if (job.state === "fail") {
      footer.title = job.error || "";
      footer.textContent = "✕ failed";
    } else if (job.state === "success") {
      footer.textContent = "✓ done";
    } else if (job.state === "cancelled") {
      footer.textContent = "cancelled";
    } else {
      footer.textContent = job.state + "…";
    }

    card.appendChild(mediaWrap);
    card.appendChild(prompt);
    card.appendChild(footer);
    grid.appendChild(card);
  });
}

// ---------- Batch polling with progress/ETA/queue/cancel/resume ----------

const activeBatchPolls = {}; // batchId -> interval id, so we can stop cleanly

function pollBatch(batchId, ids) {
  const { progressId, fillId, textId, zipId, gridId, statusId, queueCardId, queueId,
          elapsedId, etaId, resumeId, cancelId, runBtnId, kind } = ids;

  document.getElementById(progressId).hidden = false;
  document.getElementById(queueCardId).hidden = false;
  const startedAt = Date.now();

  const cancelBtn = document.getElementById(cancelId);
  const resumeBtn = document.getElementById(resumeId);

  cancelBtn.onclick = async () => {
    cancelBtn.disabled = true;
    try { await fetch(`/api/batch/${batchId}/cancel`, { method: "POST" }); }
    catch (e) { /* ignore */ }
  };
  resumeBtn.onclick = async () => {
    resumeBtn.disabled = true;
    try {
      const res = await fetch(`/api/batch/${batchId}/resume`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        resumeBtn.hidden = true;
        cancelBtn.hidden = false;
        cancelBtn.disabled = false;
        startPoll();
      } else {
        setStatus(document.getElementById(statusId), data.error || "Could not resume", "err");
        resumeBtn.disabled = false;
      }
    } catch (e) {
      setStatus(document.getElementById(statusId), e.message, "err");
      resumeBtn.disabled = false;
    }
  };

  function startPoll() {
    if (activeBatchPolls[batchId]) clearInterval(activeBatchPolls[batchId]);
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/batch/${batchId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Batch status failed");

        renderBulkGrid(gridId, data.jobs, kind);
        renderQueue(queueId, data.jobs);

        const { total, success, fail, cancelled } = data.summary;
        const completed = success + fail + cancelled;
        const pct = total ? Math.round((completed / total) * 100) : 0;
        document.getElementById(fillId).style.width = pct + "%";
        document.getElementById(textId).textContent =
          `${completed} of ${total} complete, ${fail} failed` + (cancelled ? `, ${cancelled} cancelled` : "");

        const elapsedSecs = (Date.now() - startedAt) / 1000;
        document.getElementById(elapsedId).textContent = "Elapsed: " + fmtDuration(elapsedSecs);
        if (completed > 0 && completed < total) {
          const rate = elapsedSecs / completed;
          const remaining = (total - completed) * rate;
          document.getElementById(etaId).textContent = "ETA: " + fmtDuration(remaining);
        } else if (completed >= total) {
          document.getElementById(etaId).textContent = "ETA: 0s";
        }

        if (data.cancelled && !data.running) {
          clearInterval(interval);
          delete activeBatchPolls[batchId];
          cancelBtn.hidden = true;
          resumeBtn.hidden = false;
          resumeBtn.disabled = false;
          setStatus(document.getElementById(statusId), "Batch cancelled — remaining items were left queued.", "err");
          const runBtn = document.getElementById(runBtnId);
          if (runBtn) runBtn.disabled = false;
        } else if (data.done) {
          clearInterval(interval);
          delete activeBatchPolls[batchId];
          cancelBtn.hidden = true;
          resumeBtn.hidden = true;
          const zipLink = document.getElementById(zipId);
          if (success > 0) {
            zipLink.href = `/api/batch/${batchId}/zip`;
            zipLink.hidden = false;
          }
          setStatus(document.getElementById(statusId),
            fail ? `Batch finished — ${success} succeeded, ${fail} failed.` : "Batch finished — all succeeded.",
            fail ? "err" : "ok");
          const runBtn = document.getElementById(runBtnId);
          if (runBtn) runBtn.disabled = false;
          loadCredits();
        }
      } catch (e) {
        clearInterval(interval);
        delete activeBatchPolls[batchId];
        setStatus(document.getElementById(statusId), e.message, "err");
      }
    }, 2500);
    activeBatchPolls[batchId] = interval;
  }

  startPoll();
}

// ---------- Bulk image ----------

let bulkImageRefUrl = null;
let selectedBulkImageCharUrls = [];

wireDrop("bulk-image-ref-drop", "bulk-image-ref-file", "bulk-image-ref-preview", async (file) => {
  setStatus(document.getElementById("bulk-image-status"), "Uploading reference image…");
  try {
    bulkImageRefUrl = await uploadFile(file);
    setStatus(document.getElementById("bulk-image-status"), "Reference image ready.", "ok");
  } catch (e) {
    setStatus(document.getElementById("bulk-image-status"), e.message, "err");
  }
});

document.getElementById("bulk-image-run").addEventListener("click", async () => {
  const btn = document.getElementById("bulk-image-run");
  const statusEl = document.getElementById("bulk-image-status");
  const raw = document.getElementById("bulk-image-prompts").value;
  const stylePrefix = document.getElementById("bulk-image-style-pills").dataset.value || "";
  const prompts = raw.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 150)
    .map((p) => stylePrefix + p);
  const aspect = document.getElementById("bulk-image-aspect-pills").dataset.value;
  const concurrency = parseInt(document.getElementById("bulk-image-concurrency").value, 10) || 4;
  const maxRetries = parseInt(document.getElementById("bulk-image-retries").value, 10) || 0;

  if (!prompts.length) { setStatus(statusEl, "Enter at least one prompt.", "err"); return; }

  btn.disabled = true;
  btn.dataset.userLocked = "1";
  setStatus(statusEl, `Queuing ${prompts.length} image${prompts.length === 1 ? "" : "s"}…`);
  document.getElementById("bulk-image-grid").innerHTML = "";
  document.getElementById("bulk-image-queue").innerHTML = "";
  document.getElementById("bulk-image-zip").hidden = true;
  document.getElementById("bulk-image-resume").hidden = true;
  document.getElementById("bulk-image-cancel").hidden = false;
  document.getElementById("bulk-image-cancel").disabled = false;

  try {
    const res = await fetch("/api/batch/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompts,
        aspect_ratio: aspect,
        image_urls: [...selectedBulkImageCharUrls, ...(bulkImageRefUrl ? [bulkImageRefUrl] : [])],
        concurrency,
        max_retries: maxRetries,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");

    setStatus(statusEl, `Running ${data.total} image generations…`);
    pollBatch(data.batch_id, {
      progressId: "bulk-image-progress", fillId: "bulk-image-progress-fill",
      textId: "bulk-image-progress-text", zipId: "bulk-image-zip",
      gridId: "bulk-image-grid", statusId: "bulk-image-status",
      queueCardId: "bulk-image-queue-card", queueId: "bulk-image-queue",
      elapsedId: "bulk-image-elapsed", etaId: "bulk-image-eta",
      resumeId: "bulk-image-resume", cancelId: "bulk-image-cancel",
      runBtnId: "bulk-image-run", kind: "image",
    });
  } catch (e) {
    setStatus(statusEl, e.message, "err");
    btn.disabled = false;
  } finally {
    delete btn.dataset.userLocked;
  }
});

// ---------- Bulk video ----------

let bulkVideoImageUrls = [];

function renderBulkVideoThumbs(urls) {
  const strip = document.getElementById("bulk-video-thumb-strip");
  strip.innerHTML = "";
  urls.forEach((u) => {
    const img = document.createElement("img");
    img.className = "bulk-thumb";
    img.src = u;
    strip.appendChild(img);
  });
}

document.getElementById("bulk-video-ref-drop").addEventListener("click", () => {
  document.getElementById("bulk-video-ref-file").click();
});

document.getElementById("bulk-video-ref-file").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const statusEl = document.getElementById("bulk-video-status");
  setStatus(statusEl, `Uploading ${files.length} image${files.length === 1 ? "" : "s"}…`);
  try {
    const urls = [];
    for (const f of files) {
      urls.push(await uploadFile(f));
      setStatus(statusEl, `Uploaded ${urls.length} / ${files.length}…`);
    }
    bulkVideoImageUrls = urls;
    renderBulkVideoThumbs(urls);
    setStatus(statusEl, `${urls.length} image${urls.length === 1 ? "" : "s"} ready.`, "ok");
  } catch (err) {
    setStatus(statusEl, err.message, "err");
  }
});

document.getElementById("bulk-video-run").addEventListener("click", async () => {
  const btn = document.getElementById("bulk-video-run");
  const statusEl = document.getElementById("bulk-video-status");
  const raw = document.getElementById("bulk-video-prompts").value;
  const prompts = raw.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 150);
  const aspect = document.getElementById("bulk-video-aspect-pills").dataset.value;
  const duration = parseInt(document.getElementById("bulk-video-duration").value, 10) || 8;
  const concurrency = parseInt(document.getElementById("bulk-video-concurrency").value, 10) || 3;
  const maxRetries = parseInt(document.getElementById("bulk-video-retries").value, 10) || 0;

  if (!prompts.length) { setStatus(statusEl, "Enter at least one prompt.", "err"); return; }
  if (!bulkVideoImageUrls.length) { setStatus(statusEl, "Upload at least one source image.", "err"); return; }
  if (bulkVideoImageUrls.length !== 1 && bulkVideoImageUrls.length !== prompts.length) {
    setStatus(statusEl, `Upload exactly 1 image (used for all) or exactly ${prompts.length} images (one per prompt). You uploaded ${bulkVideoImageUrls.length}.`, "err");
    return;
  }

  btn.disabled = true;
  btn.dataset.userLocked = "1";
  setStatus(statusEl, `Queuing ${prompts.length} video${prompts.length === 1 ? "" : "s"}…`);
  document.getElementById("bulk-video-grid").innerHTML = "";
  document.getElementById("bulk-video-queue").innerHTML = "";
  document.getElementById("bulk-video-zip").hidden = true;
  document.getElementById("bulk-video-resume").hidden = true;
  document.getElementById("bulk-video-cancel").hidden = false;
  document.getElementById("bulk-video-cancel").disabled = false;

  try {
    const res = await fetch("/api/batch/video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompts,
        image_urls: bulkVideoImageUrls,
        aspect_ratio: aspect,
        duration,
        concurrency,
        max_retries: maxRetries,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");

    setStatus(statusEl, `Running ${data.total} video generations… this can take a while for large batches`);
    pollBatch(data.batch_id, {
      progressId: "bulk-video-progress", fillId: "bulk-video-progress-fill",
      textId: "bulk-video-progress-text", zipId: "bulk-video-zip",
      gridId: "bulk-video-grid", statusId: "bulk-video-status",
      queueCardId: "bulk-video-queue-card", queueId: "bulk-video-queue",
      elapsedId: "bulk-video-elapsed", etaId: "bulk-video-eta",
      resumeId: "bulk-video-resume", cancelId: "bulk-video-cancel",
      runBtnId: "bulk-video-run", kind: "video",
    });
  } catch (e) {
    setStatus(statusEl, e.message, "err");
    btn.disabled = false;
  } finally {
    delete btn.dataset.userLocked;
  }
});


// ============================================================
// Reference library — Whisk-style Subject / Scene / Style
// ============================================================

const CATEGORIES = ["subject", "scene", "style"];

let charactersCache = [];

// The single "active" pick per category — this is the shared state that
// both the Characters tab cards and the Image/Bulk Image picker rows
// read from and write to, so picking a subject in one place is reflected
// everywhere else immediately (just like Whisk's left rail).
let activeRef = { subject: null, scene: null, style: null };

const viewRefreshers = []; // every rendered view (grids + picker rows) re-renders on any change

function byCategory(cat) {
  return charactersCache.filter((c) => (c.category || "subject") === cat);
}

async function loadCharacters() {
  try {
    const res = await fetch("/api/characters");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load library");
    charactersCache = data.characters || [];
  } catch (e) {
    charactersCache = [];
  }
  // Drop any active selection that no longer exists (e.g. after a delete)
  CATEGORIES.forEach((cat) => {
    if (activeRef[cat] && !charactersCache.find((c) => c.id === activeRef[cat].id)) {
      activeRef[cat] = null;
    }
  });
  recomputeSelections();
  viewRefreshers.forEach((fn) => fn());
}

function setActive(cat, character) {
  activeRef[cat] = activeRef[cat] && character && activeRef[cat].id === character.id ? null : character;
  recomputeSelections();
  viewRefreshers.forEach((fn) => fn());
}

// Combines whatever's active in Subject/Scene/Style into the flat
// image_urls arrays the Image and Bulk Image generation calls expect.
function recomputeSelections() {
  const urls = CATEGORIES.map((cat) => activeRef[cat] && activeRef[cat].image_url).filter(Boolean);
  selectedImageCharUrls = urls;
  selectedBulkImageCharUrls = urls;
}

// ---------- Characters tab: per-category grid with active checkmark ----------

function renderCategoryGrid(cat) {
  const grid = document.getElementById(`grid-${cat}`);
  const empty = document.querySelector(`.cat-empty[data-category="${cat}"]`);
  const countPill = document.getElementById(`cat-count-${cat}`);
  const activeLabel = document.getElementById(`active-label-${cat}`);
  const items = byCategory(cat);

  grid.innerHTML = "";
  empty.hidden = items.length > 0;
  countPill.textContent = `${items.length} saved`;
  activeLabel.textContent = activeRef[cat] ? `Active: ${activeRef[cat].name}` : "None active";

  items.forEach((c) => {
    const isActive = activeRef[cat] && activeRef[cat].id === c.id;
    const card = document.createElement("div");
    card.className = "character-card" + (isActive ? " active" : "");

    const imgWrap = document.createElement("div");
    imgWrap.className = "character-card-img-wrap";
    const img = document.createElement("img");
    img.src = c.image_url;
    imgWrap.appendChild(img);

    const check = document.createElement("div");
    check.className = "character-card-check";
    check.textContent = "✓";
    imgWrap.appendChild(check);

    const name = document.createElement("div");
    name.className = "character-card-name";
    name.textContent = c.name;
    name.title = c.name;

    const delBtn = document.createElement("button");
    delBtn.className = "character-card-delete";
    delBtn.textContent = "✕";
    delBtn.title = "Delete " + c.name;
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${c.name}"? This can't be undone.`)) return;
      try {
        await fetch(`/api/characters/${c.id}`, { method: "DELETE" });
        await loadCharacters();
      } catch (err) {
        setStatus(document.querySelector(`.cat-status[data-category="${cat}"]`), err.message, "err");
      }
    });

    card.addEventListener("click", () => setActive(cat, c));

    card.appendChild(imgWrap);
    card.appendChild(name);
    card.appendChild(delBtn);
    grid.appendChild(card);
  });
}

// ---------- Image/Bulk Image tabs: compact chip row per category ----------

function renderCategoryPicker(containerId, cat) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const items = byCategory(cat);
  container.innerHTML = "";

  if (!items.length) {
    const msg = document.createElement("span");
    msg.className = "char-picker-empty";
    msg.textContent = `No ${cat}s saved yet — add some in the Characters tab.`;
    container.appendChild(msg);
    return;
  }

  items.forEach((c) => {
    const isActive = activeRef[cat] && activeRef[cat].id === c.id;
    const chip = document.createElement("div");
    chip.className = "char-chip" + (isActive ? " selected" : "");

    const img = document.createElement("img");
    img.src = c.image_url;
    const label = document.createElement("span");
    label.textContent = c.name;

    chip.appendChild(img);
    chip.appendChild(label);
    chip.addEventListener("click", () => setActive(cat, c));
    container.appendChild(chip);
  });
}

CATEGORIES.forEach((cat) => {
  viewRefreshers.push(() => renderCategoryGrid(cat));
  viewRefreshers.push(() => renderCategoryPicker(`image-${cat}-picker`, cat));
  viewRefreshers.push(() => renderCategoryPicker(`bulk-image-${cat}-picker`, cat));
});

// ---------- Per-category upload forms (Characters tab) ----------

CATEGORIES.forEach((cat) => {
  const dropEl = document.querySelector(`.cat-upload-drop[data-category="${cat}"]`);
  const fileInput = document.querySelector(`.cat-upload-file[data-category="${cat}"]`);
  const preview = document.querySelector(`.cat-upload-preview[data-category="${cat}"]`);
  const nameInput = document.querySelector(`.cat-name-input[data-category="${cat}"]`);
  const addBtn = document.querySelector(`.cat-add-btn[data-category="${cat}"]`);
  const statusEl = document.querySelector(`.cat-status[data-category="${cat}"]`);

  dropEl.addEventListener("click", () => fileInput.click());
  dropEl.addEventListener("dragover", (e) => { e.preventDefault(); dropEl.style.borderColor = "var(--accent)"; });
  dropEl.addEventListener("dragleave", () => { dropEl.style.borderColor = ""; });
  dropEl.addEventListener("drop", (e) => {
    e.preventDefault();
    dropEl.style.borderColor = "";
    if (e.dataTransfer.files[0]) {
      fileInput.files = e.dataTransfer.files;
      showPreview(e.dataTransfer.files[0]);
    }
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) showPreview(fileInput.files[0]);
  });

  function showPreview(file) {
    const reader = new FileReader();
    reader.onload = () => {
      preview.src = reader.result;
      preview.hidden = false;
      dropEl.querySelector(".drop-text").style.display = "none";
    };
    reader.readAsDataURL(file);
  }

  addBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const file = fileInput.files[0];
    if (!name) { setStatus(statusEl, "Give it a name.", "err"); return; }
    if (!file) { setStatus(statusEl, "Upload a reference image.", "err"); return; }

    addBtn.disabled = true;
    setStatus(statusEl, "Uploading…");
    try {
      const form = new FormData();
      form.append("name", name);
      form.append("category", cat);
      form.append("file", file);
      const res = await fetch("/api/characters", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add");

      nameInput.value = "";
      fileInput.value = "";
      preview.hidden = true;
      dropEl.querySelector(".drop-text").style.display = "";

      setStatus(statusEl, `"${data.character.name}" added to ${cat}.`, "ok");
      await loadCharacters();
    } catch (e) {
      setStatus(statusEl, e.message, "err");
    } finally {
      addBtn.disabled = false;
    }
  });
});

// ---------- Video / Bulk Video pickers: single-select across the whole library ----------
//
// The Subject/Scene/Style split is specific to image generation (that's
// what Whisk itself does). Video only takes one source image, so its
// picker just shows everything in the library regardless of category.

function createSimplePicker(containerId, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let selected = null;

  function render() {
    container.innerHTML = "";
    if (!charactersCache.length) {
      const msg = document.createElement("span");
      msg.className = "char-picker-empty";
      msg.textContent = "No saved references yet — add some in the Characters tab.";
      container.appendChild(msg);
      return;
    }
    charactersCache.forEach((c) => {
      const isSelected = selected === c.image_url;
      const chip = document.createElement("div");
      chip.className = "char-chip" + (isSelected ? " selected" : "");

      const img = document.createElement("img");
      img.src = c.image_url;
      const label = document.createElement("span");
      label.textContent = `${c.name} · ${c.category || "subject"}`;

      chip.appendChild(img);
      chip.appendChild(label);
      chip.addEventListener("click", () => {
        selected = selected === c.image_url ? null : c.image_url;
        onChange(selected);
        render();
      });
      container.appendChild(chip);
    });
  }

  viewRefreshers.push(render);
  render();
}

createSimplePicker("video-char-picker", (url) => {
  selectedVideoCharUrl = url;
  const preview = document.getElementById("video-ref-preview");
  if (url) {
    videoRefUrl = null; // library selection takes priority over an ad-hoc upload
    preview.src = url;
    preview.hidden = false;
    document.querySelector("#video-ref-drop .drop-text").style.display = "none";
  } else if (!videoRefUrl) {
    preview.hidden = true;
    document.querySelector("#video-ref-drop .drop-text").style.display = "";
  }
});

createSimplePicker("bulk-video-char-picker", (url) => {
  if (url) {
    bulkVideoImageUrls = [url];
    renderBulkVideoThumbs([url]);
    setStatus(document.getElementById("bulk-video-status"), "Using selected reference for all prompts.", "ok");
  }
});

loadCharacters();

// ============================================================
// Lightbox — full-size preview with prev/next through a gallery
// ============================================================

let lightboxItems = [];
let lightboxIndex = 0;

function renderLightbox() {
  const wrap = document.getElementById("lightbox-media-wrap");
  const promptEl = document.getElementById("lightbox-prompt");
  const dl = document.getElementById("lightbox-download");
  const prevBtn = document.getElementById("lightbox-prev");
  const nextBtn = document.getElementById("lightbox-next");

  const item = lightboxItems[lightboxIndex];
  if (!item || !item.url) {
    closeLightbox();
    return;
  }

  wrap.innerHTML = "";
  if (item.kind === "image") {
    const img = document.createElement("img");
    img.src = item.url;
    img.onerror = () => { wrap.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Couldn\'t load this image — it may have expired on kie.ai\'s side.</p>'; };
    wrap.appendChild(img);
  } else if (item.kind === "video") {
    const vid = document.createElement("video");
    vid.src = item.url;
    vid.controls = true;
    vid.autoplay = true;
    vid.onerror = () => { wrap.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">Couldn\'t load this video — it may have expired on kie.ai\'s side.</p>'; };
    wrap.appendChild(vid);
  } else {
    closeLightbox();
    return;
  }

  promptEl.textContent = item.prompt || "";
  dl.href = item.url;

  const showNav = lightboxItems.length > 1;
  prevBtn.hidden = !showNav;
  nextBtn.hidden = !showNav;
}

function openLightbox(items, startIndex) {
  const valid = (items || []).filter((it) => it && it.url && (it.kind === "image" || it.kind === "video"));
  if (!valid.length) return;
  lightboxItems = valid;
  lightboxIndex = Math.min(startIndex || 0, valid.length - 1);
  document.getElementById("lightbox").hidden = false;
  renderLightbox();
}

function closeLightbox() {
  document.getElementById("lightbox").hidden = true;
  document.getElementById("lightbox-media-wrap").innerHTML = "";
  lightboxItems = [];
}

document.getElementById("lightbox-close").addEventListener("click", closeLightbox);
document.getElementById("lightbox").addEventListener("click", (e) => {
  if (e.target.id === "lightbox") closeLightbox();
});
document.getElementById("lightbox-prev").addEventListener("click", () => {
  lightboxIndex = (lightboxIndex - 1 + lightboxItems.length) % lightboxItems.length;
  renderLightbox();
});
document.getElementById("lightbox-next").addEventListener("click", () => {
  lightboxIndex = (lightboxIndex + 1) % lightboxItems.length;
  renderLightbox();
});
document.addEventListener("keydown", (e) => {
  if (document.getElementById("lightbox").hidden) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") document.getElementById("lightbox-prev").click();
  if (e.key === "ArrowRight") document.getElementById("lightbox-next").click();
});
