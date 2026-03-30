/* ============================================================
   Room Visualizer — Frontend SPA
   ============================================================ */

const API = '';
let currentProject = null;
let styles = {};
let roomTypes = {};
let activeJobs = {}; // job_id -> {room_id, style}
let pollTimer = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  const [stylesRes, roomTypesRes] = await Promise.all([
    fetch(`${API}/api/styles`).then(r => r.json()),
    fetch(`${API}/api/room-types`).then(r => r.json()),
  ]);
  styles = stylesRes;
  roomTypes = roomTypesRes;
  showProjectList();
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function showProjectList() {
  currentProject = null;
  stopPolling();
  document.getElementById('view-projects').classList.remove('hidden');
  document.getElementById('view-detail').classList.add('hidden');
  document.getElementById('result-view').classList.remove('active');
  loadProjects();
}

function showProjectDetail(project) {
  currentProject = project;
  document.getElementById('view-projects').classList.add('hidden');
  document.getElementById('view-detail').classList.remove('hidden');
  renderProjectDetail();
}

// ---------------------------------------------------------------------------
// Sanitized DOM helpers
// ---------------------------------------------------------------------------

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

/** Create element from trusted template — only used with esc()-sanitized values */
function createFromTemplate(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content;
}

function setHTML(el, html) {
  el.textContent = '';
  el.appendChild(createFromTemplate(html));
}

// ---------------------------------------------------------------------------
// Project list
// ---------------------------------------------------------------------------

async function loadProjects() {
  const projects = await fetch(`${API}/api/projects`).then(r => r.json());
  const grid = document.getElementById('project-grid');

  if (projects.length === 0) {
    setHTML(grid, `
      <div class="empty-state" style="grid-column: 1 / -1">
        <div class="empty-state-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </div>
        <p>Ingen projekter endnu</p>
        <button class="btn btn-primary" onclick="openNewProjectModal()">Opret dit første projekt</button>
      </div>`);
    return;
  }

  setHTML(grid, projects.map(p => {
    const thumbs = p.rooms.slice(0, 4);
    const thumbStrip = thumbs.length > 0
      ? thumbs.map(r => `<img src="/uploads/${encodeURIComponent(r.stored_filename)}" alt="">`).join('')
      : `<div class="project-card-thumbs-empty">Ingen billeder endnu</div>`;
    const genCount = p.rooms.reduce((sum, r) => sum + Object.keys(r.generated || {}).length, 0);

    return `
    <div class="card project-card" onclick="openProject('${esc(p.id)}')">
      <div class="project-card-thumbs">${thumbStrip}</div>
      <div class="card-body">
        <h3>${esc(p.name)}</h3>
        <div class="text-sm text-muted">${esc(p.address)}</div>
        <div class="project-meta">
          <span>${esc(String(p.rooms.length))} billeder</span>
          ${genCount > 0 ? `<span>${esc(String(genCount))} genereret</span>` : ''}
          <span>${esc(p.created)}</span>
        </div>
      </div>
    </div>`;
  }).join(''));
}

async function openProject(id) {
  const project = await fetch(`${API}/api/projects/${encodeURIComponent(id)}`).then(r => r.json());
  showProjectDetail(project);
}

function openNewProjectModal() {
  document.getElementById('modal-new-project').classList.add('active');
  document.getElementById('input-project-name').focus();
}

function closeNewProjectModal() {
  document.getElementById('modal-new-project').classList.remove('active');
  document.getElementById('input-project-name').value = '';
  document.getElementById('input-project-address').value = '';
}

async function createProject() {
  const name = document.getElementById('input-project-name').value.trim();
  const address = document.getElementById('input-project-address').value.trim();
  if (!name) return;

  const project = await fetch(`${API}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, address }),
  }).then(r => r.json());

  closeNewProjectModal();
  showProjectDetail(project);
}

async function deleteProject(id) {
  if (!confirm('Er du sikker på du vil slette dette projekt og alle dets billeder?')) return;
  await fetch(`${API}/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  showProjectList();
}

// ---------------------------------------------------------------------------
// Project detail
// ---------------------------------------------------------------------------

function renderProjectDetail() {
  const p = currentProject;
  document.getElementById('detail-breadcrumb-name').textContent = p.name;
  document.getElementById('detail-title').textContent = p.name;
  document.getElementById('detail-address').textContent = p.address;

  // Show/hide upload zone based on whether rooms exist
  const uploadZone = document.getElementById('upload-zone');
  const uploadBtn = document.getElementById('upload-btn');
  if (p.rooms.length > 0) {
    uploadZone.classList.add('hidden');
    uploadBtn.classList.remove('hidden');
  } else {
    uploadZone.classList.remove('hidden');
    uploadBtn.classList.add('hidden');
  }

  // Update results count badge
  updateResultsCount();

  renderStats();
  renderRooms();
}

let currentTab = 'edit';

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-edit').classList.toggle('active', tab === 'edit');
  document.getElementById('tab-results').classList.toggle('active', tab === 'results');
  document.getElementById('tab-panel-edit').classList.toggle('hidden', tab !== 'edit');
  document.getElementById('tab-panel-results').classList.toggle('hidden', tab !== 'results');

  if (tab === 'results') renderResultsGallery();
  updateStickyBar();
}

function updateResultsCount() {
  if (!currentProject) return;
  const count = currentProject.rooms.reduce((sum, r) => sum + Object.keys(r.generated || {}).length, 0);
  const badge = document.getElementById('tab-results-count');
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

let resultsFilter = 'all';
let selectedResults = new Set(); // "roomId:styleKey" keys

function renderResultsGallery() {
  const container = document.getElementById('results-gallery');
  const rooms = currentProject.rooms;

  // Collect all generated images grouped by style
  const byStyle = {};
  for (const room of rooms) {
    for (const [styleKey, filename] of Object.entries(room.generated || {})) {
      if (!byStyle[styleKey]) byStyle[styleKey] = [];
      byStyle[styleKey].push({ room, filename, styleKey });
    }
  }

  const styleKeys = Object.keys(byStyle);

  if (styleKeys.length === 0) {
    setHTML(container, `<div class="results-empty">Ingen resultater endnu. Vælg stilarter og klik "Generer" på Billeder-fanen.</div>`);
    return;
  }

  // Filter tabs
  let html = `<div class="results-toolbar">`;
  html += `<div class="results-filters">`;
  html += `<button class="results-filter ${resultsFilter === 'all' ? 'active' : ''}" onclick="setResultsFilter('all')">Alle</button>`;
  for (const sk of styleKeys) {
    html += `<button class="results-filter ${resultsFilter === sk ? 'active' : ''}" onclick="setResultsFilter('${esc(sk)}')">${esc(styles[sk]?.name || sk)} (${byStyle[sk].length})</button>`;
  }
  html += `</div>`;

  // Bulk actions
  html += `<div class="results-bulk">`;
  if (selectedResults.size > 0) {
    html += `<span class="results-bulk-count">${selectedResults.size} valgt</span>`;
    html += `<button class="btn btn-primary btn-sm" onclick="downloadSelected()">Download (${selectedResults.size})</button>`;
    html += `<button class="btn btn-ghost btn-sm" onclick="deleteSelected()" style="color:var(--red)">Slet</button>`;
    html += `<button class="btn btn-ghost btn-sm" onclick="clearSelection()">Ryd</button>`;
  } else {
    html += `<button class="btn btn-ghost btn-sm" onclick="selectAllVisible()">Vælg alle</button>`;
  }
  html += `</div></div>`;

  // Filtered items
  const visibleStyles = resultsFilter === 'all' ? styleKeys : [resultsFilter];

  for (const styleKey of visibleStyles) {
    if (!byStyle[styleKey]) continue;
    const styleName = styles[styleKey]?.name || styleKey;
    const items = byStyle[styleKey];

    // Only show heading if showing all styles
    if (resultsFilter === 'all') {
      html += `<div class="results-style-section"><h2>${esc(styleName)}</h2>`;
    } else {
      html += `<div class="results-style-section">`;
    }
    html += `<div class="results-grid">`;

    for (const item of items) {
      const selKey = `${item.room.id}:${item.styleKey}`;
      const isSelected = selectedResults.has(selKey);
      const dlName = `${esc(currentProject.name)}_${esc(item.room.original_filename.replace(/\.[^.]+$/, ''))}_${esc(styleName)}.png`;

      html += `
        <div class="results-card ${isSelected ? 'selected' : ''}">
          <div class="results-card-select" onclick="event.stopPropagation(); toggleResultSelect('${esc(selKey)}')">
            <div class="results-checkbox ${isSelected ? 'checked' : ''}">
              ${isSelected ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
            </div>
          </div>
          <img class="results-card-img" src="/generated/${encodeURIComponent(item.filename)}" alt="${esc(styleName)}" onclick="showResult('${esc(item.room.id)}', '${esc(item.styleKey)}')">
          <div class="results-card-label">
            <span>${esc(item.room.original_filename)}</span>
            <a href="/generated/${encodeURIComponent(item.filename)}" download="${dlName}" class="results-download" onclick="event.stopPropagation()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </a>
          </div>
        </div>`;
    }

    html += `</div></div>`;
  }

  setHTML(container, html);
}

function setResultsFilter(filter) {
  resultsFilter = filter;
  renderResultsGallery();
}

function toggleResultSelect(key) {
  if (selectedResults.has(key)) selectedResults.delete(key);
  else selectedResults.add(key);
  renderResultsGallery();
}

function selectAllVisible() {
  const rooms = currentProject.rooms;
  const visibleStyles = resultsFilter === 'all' ? Object.keys(styles) : [resultsFilter];
  for (const room of rooms) {
    for (const [sk] of Object.entries(room.generated || {})) {
      if (visibleStyles.includes(sk)) selectedResults.add(`${room.id}:${sk}`);
    }
  }
  renderResultsGallery();
}

function clearSelection() {
  selectedResults.clear();
  renderResultsGallery();
}

async function deleteSelected() {
  if (!confirm(`Slet ${selectedResults.size} genererede billeder?`)) return;

  for (const key of selectedResults) {
    const [roomId, styleKey] = key.split(':');
    const room = currentProject.rooms.find(r => r.id === roomId);
    if (!room) continue;

    await fetch(`${API}/api/projects/${encodeURIComponent(currentProject.id)}/rooms/${encodeURIComponent(roomId)}/generated/${encodeURIComponent(styleKey)}`, {
      method: 'DELETE',
    });

    // Update local state
    if (room.generated) delete room.generated[styleKey];
  }

  selectedResults.clear();
  updateResultsCount();
  renderResultsGallery();
  toast(`${selectedResults.size || 'Billeder'} slettet`, 'success');
}

async function downloadSelected() {
  const rooms = currentProject.rooms;
  for (const key of selectedResults) {
    const [roomId, styleKey] = key.split(':');
    const room = rooms.find(r => r.id === roomId);
    if (!room || !room.generated[styleKey]) continue;
    const styleName = styles[styleKey]?.name || styleKey;
    const a = document.createElement('a');
    a.href = `/generated/${encodeURIComponent(room.generated[styleKey])}`;
    a.download = `${currentProject.name}_${room.original_filename.replace(/\.[^.]+$/, '')}_${styleName}.png`;
    a.click();
    // Small delay between downloads to avoid browser blocking
    await new Promise(r => setTimeout(r, 200));
  }
}

function renderStats() {
  const el = document.getElementById('project-stats');
  const rooms = currentProject.rooms;

  if (rooms.length === 0) {
    el.classList.add('hidden');
    return;
  }

  el.classList.remove('hidden');

  const totalRooms = rooms.length;
  const totalStylesSelected = rooms.reduce((sum, r) => sum + (r.selected_styles || []).length, 0);
  const totalGenerated = rooms.reduce((sum, r) => sum + Object.keys(r.generated || {}).length, 0);
  const generating = Object.values(activeJobs).filter(j => j.status === 'generating').length;

  let html = `
    <span class="stat"><span class="stat-value">${totalRooms}</span> billeder</span>
    <span class="stat-divider"></span>
    <span class="stat"><span class="stat-value">${totalStylesSelected}</span> stilarter valgt</span>
    <span class="stat-divider"></span>
    <span class="stat"><span class="stat-value">${totalGenerated}</span> genereret</span>`;

  if (generating > 0) {
    html += `<span class="stat-divider"></span>
    <span class="stat"><span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span> ${generating} i gang</span>`;
  }

  setHTML(el, html);
}

function renderBulkStyles() {
  const container = document.getElementById('bulk-styles');
  const chipsEl = document.getElementById('bulk-style-chips');
  const rooms = currentProject.rooms;

  if (rooms.length === 0) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');

  // A style is "active" in bulk if ALL rooms have it selected
  const allStyleKeys = Object.keys(styles);
  const bulkActive = allStyleKeys.filter(key =>
    rooms.every(r => (r.selected_styles || []).includes(key))
  );

  setHTML(chipsEl, allStyleKeys.map(key => {
    const active = bulkActive.includes(key) ? 'active' : '';
    const desc = styles[key].description || '';
    return `<span class="style-chip ${active}" data-style="${esc(key)}" onclick="toggleBulkStyle('${esc(key)}')" title="${esc(desc)}">${esc(styles[key].name)}</span>`;
  }).join(''));

  // Dynamic bulk action buttons
  const totalSelected = rooms.reduce((sum, r) => sum + (r.selected_styles || []).length, 0);
  const totalPossible = rooms.length * allStyleKeys.length;
  const actionsEl = document.getElementById('bulk-actions');

  let btns = '';
  if (totalSelected > 0) {
    btns += `<button class="btn btn-ghost btn-sm" onclick="clearAllStyles()">Ryd</button>`;
  }
  if (totalSelected < totalPossible) {
    btns += `<button class="btn btn-secondary btn-sm" onclick="selectAllStyles()">Vælg alle (${totalPossible})</button>`;
  }
  setHTML(actionsEl, btns);
}

async function selectAllStyles() {
  const rooms = currentProject.rooms;
  if (!rooms.length) return;

  const allStyleKeys = Object.keys(styles);
  for (const room of rooms) {
    const selected = room.selected_styles || [];
    let changed = false;
    for (const key of allStyleKeys) {
      if (!selected.includes(key)) {
        selected.push(key);
        changed = true;
      }
    }
    if (changed) {
      room.selected_styles = selected;
      await fetch(`${API}/api/projects/${encodeURIComponent(currentProject.id)}/rooms/${encodeURIComponent(room.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_styles: selected }),
      });
    }
  }

  renderBulkStyles();
  renderRooms();
}

async function clearAllStyles() {
  const rooms = currentProject.rooms;
  if (!rooms.length) return;

  for (const room of rooms) {
    if ((room.selected_styles || []).length > 0) {
      room.selected_styles = [];
      await fetch(`${API}/api/projects/${encodeURIComponent(currentProject.id)}/rooms/${encodeURIComponent(room.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_styles: [] }),
      });
    }
  }

  renderBulkStyles();
  renderRooms();
}

async function toggleBulkStyle(styleKey) {
  const rooms = currentProject.rooms;
  if (!rooms.length) return;

  // If all rooms have it, remove from all. Otherwise add to all.
  const allHave = rooms.every(r => (r.selected_styles || []).includes(styleKey));

  for (const room of rooms) {
    const selected = room.selected_styles || [];
    const idx = selected.indexOf(styleKey);

    if (allHave && idx >= 0) {
      selected.splice(idx, 1);
    } else if (!allHave && idx < 0) {
      selected.push(styleKey);
    }

    const updated = await fetch(`${API}/api/projects/${encodeURIComponent(currentProject.id)}/rooms/${encodeURIComponent(room.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected_styles: selected }),
    }).then(r => r.json());

    Object.assign(room, updated);
  }

  renderBulkStyles();
  renderRooms();
}

function renderRooms() {
  const grid = document.getElementById('rooms-grid');
  const rooms = currentProject.rooms;

  renderBulkStyles();
  renderStats();
  updateStickyBar();

  if (rooms.length === 0) {
    setHTML(grid, `
      <div class="empty-state" style="grid-column: 1 / -1">
        <div class="empty-state-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </div>
        <p>Upload billeder for at komme i gang</p>
      </div>`);
    return;
  }

  setHTML(grid, rooms.map(room => {
    const roomTypeOptions = Object.entries(roomTypes)
      .map(([k, v]) => `<option value="${esc(k)}" ${room.room_type === k ? 'selected' : ''}>${esc(v)}</option>`)
      .join('');
    const targetOptions = `<option value="">Samme rum</option>` +
      Object.entries(roomTypes)
        .map(([k, v]) => `<option value="${esc(k)}" ${room.target_room_type === k ? 'selected' : ''}>${esc(v)}</option>`)
        .join('');

    // Chips: click always toggles selection. ✓ = generated. Spinner = generating.
    const generatingStyles = Object.entries(activeJobs)
      .filter(([_, j]) => j.room_id === room.id && j.status === 'generating')
      .map(([_, j]) => j.style);

    const styleChips = Object.entries(styles).map(([key, s]) => {
      const isSelected = (room.selected_styles || []).includes(key);
      const isGenerated = key in (room.generated || {});
      const isGenerating = generatingStyles.includes(key);

      let cls = 'style-chip';
      let suffix = '';

      if (isGenerating) {
        cls += ' active';
        suffix = ` <span class="chip-spinner"></span>`;
      } else if (isSelected) {
        cls += ' active';
        if (isGenerated) suffix = ` ✓`;
      }

      const desc = s.description || '';
      return `<span class="${cls}" data-room="${esc(room.id)}" data-style="${esc(key)}" onclick="${isGenerating ? '' : 'toggleStyle(this)'}" title="${esc(desc)}">${esc(s.name)}${suffix}</span>`;
    }).join('');

    return `
    <div class="card room-card">
      <div class="room-card-image">
        <img src="/uploads/${encodeURIComponent(room.stored_filename)}" alt="${esc(room.original_filename)}">
        <div class="room-card-overlay">
          <button class="btn btn-icon btn-overlay-icon" onclick="deleteRoom('${esc(room.id)}')" title="Slet">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>
      <div class="room-card-body">
        <div class="style-chips">${styleChips}</div>
        <span class="room-card-convert-link" onclick="event.preventDefault(); toggleConvert('${esc(room.id)}')">Ændr rumtype</span>
        <div class="room-card-convert hidden" id="convert-${esc(room.id)}">
          <div class="room-card-selects">
            <div class="room-card-field">
              <label class="field-label">Nuværende</label>
              <select class="select" onchange="updateRoom('${esc(room.id)}', {room_type: this.value})">${roomTypeOptions}</select>
            </div>
            <div class="room-card-field">
              <label class="field-label">Ændres til</label>
              <select class="select" onchange="updateRoom('${esc(room.id)}', {target_room_type: this.value || null})">${targetOptions}</select>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }).join(''));
}

// ---------------------------------------------------------------------------
// Room operations
// ---------------------------------------------------------------------------

/** Generated chip: click to view result, or toggle selection off */
function chipClick(_chip, roomId, styleKey) {
  const room = currentProject.rooms.find(r => r.id === roomId);
  if (!room) return;

  // If generated, open result view
  if (room.generated && room.generated[styleKey]) {
    showResult(roomId, styleKey);
  }
}

function toggleConvert(roomId) {
  const el = document.getElementById(`convert-${roomId}`);
  el.classList.toggle('hidden');
}

async function toggleStyle(chip) {
  const roomId = chip.dataset.room;
  const styleKey = chip.dataset.style;
  const room = currentProject.rooms.find(r => r.id === roomId);
  if (!room) return;

  const selected = room.selected_styles || [];
  const idx = selected.indexOf(styleKey);
  if (idx >= 0) selected.splice(idx, 1);
  else selected.push(styleKey);

  const updated = await fetch(`${API}/api/projects/${encodeURIComponent(currentProject.id)}/rooms/${encodeURIComponent(roomId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selected_styles: selected }),
  }).then(r => r.json());

  Object.assign(room, updated);
  renderRooms();
}

async function updateRoom(roomId, data) {
  const room = currentProject.rooms.find(r => r.id === roomId);
  if (!room) return;

  const updated = await fetch(`${API}/api/projects/${encodeURIComponent(currentProject.id)}/rooms/${encodeURIComponent(roomId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(r => r.json());

  Object.assign(room, updated);
}

async function deleteRoom(roomId) {
  if (!confirm('Slet dette billede?')) return;
  await fetch(`${API}/api/projects/${encodeURIComponent(currentProject.id)}/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
  currentProject.rooms = currentProject.rooms.filter(r => r.id !== roomId);
  renderRooms();
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function setupUploadZone() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('upload-input');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', async e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    // Support folder drops via webkitGetAsEntry
    const items = e.dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      const files = await readDroppedEntries(items);
      handleFiles(files);
    } else {
      handleFiles(e.dataTransfer.files);
    }
  });
  input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });

  const folderInput = document.getElementById('upload-folder-input');
  folderInput.addEventListener('change', () => {
    // Filter to only image files from the folder
    const imageFiles = Array.from(folderInput.files).filter(f => f.type.startsWith('image/'));
    handleFiles(imageFiles);
    folderInput.value = '';
  });
}

/** Recursively read files from dropped folder entries */
async function readDroppedEntries(dataTransferItems) {
  const files = [];
  const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];

  function readEntry(entry) {
    return new Promise(resolve => {
      if (entry.isFile) {
        entry.file(f => {
          if (imageTypes.includes(f.type)) files.push(f);
          resolve();
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        reader.readEntries(async entries => {
          for (const e of entries) await readEntry(e);
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  for (const item of dataTransferItems) {
    const entry = item.webkitGetAsEntry();
    if (entry) await readEntry(entry);
  }
  return files;
}

async function handleFiles(files) {
  // Accept both FileList and Array
  const fileArr = Array.from(files);
  if (!currentProject || !fileArr.length) return;

  const fd = new FormData();
  for (const f of fileArr) fd.append('images', f);

  try {
    const res = await fetch(`${API}/api/projects/${encodeURIComponent(currentProject.id)}/upload`, {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) { toast('Upload fejlede', 'error'); return; }
    const newRooms = await res.json();
    currentProject.rooms.push(...newRooms);
    // Hide upload zone, show upload button
    document.getElementById('upload-zone').classList.add('hidden');
    document.getElementById('upload-btn').classList.remove('hidden');
    renderRooms();
    toast(`${newRooms.length} billede${newRooms.length > 1 ? 'r' : ''} uploadet`, 'success');
  } catch (e) {
    toast(`Upload fejl: ${e.message}`, 'error');
  }
}

document.addEventListener('DOMContentLoaded', setupUploadZone);

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

async function generateRoom(roomId) {
  const room = currentProject.rooms.find(r => r.id === roomId);
  if (!room) return;

  const roomStyles = room.selected_styles || [];
  if (roomStyles.length === 0) {
    toast('Vælg mindst én stil først', 'error');
    return;
  }

  // Optimistic UI: show generating state immediately
  const tempJobs = {};
  for (const s of roomStyles) {
    const tempId = `temp_${roomId}_${s}`;
    tempJobs[tempId] = { room_id: roomId, style: s, status: 'generating' };
    activeJobs[tempId] = tempJobs[tempId];
  }
  document.getElementById('sticky-bar').classList.add('hidden');
  renderRooms();
  toast(`Genererer ${roomStyles.length} billede${roomStyles.length > 1 ? 'r' : ''}...`);

  const res = await fetch(`${API}/api/projects/${encodeURIComponent(currentProject.id)}/rooms/${encodeURIComponent(roomId)}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ styles: roomStyles }),
  }).then(r => r.json());

  // Replace temp jobs with real ones
  for (const tempId of Object.keys(tempJobs)) delete activeJobs[tempId];
  for (const job of res) {
    activeJobs[job.job_id] = { room_id: roomId, style: job.style, status: 'generating' };
  }

  renderRooms();
  startPolling();
}

async function generateAll() {
  if (!currentProject) return;

  // Optimistic UI: count what will be generated
  let tempCount = 0;
  for (const room of currentProject.rooms) {
    for (const s of (room.selected_styles || [])) {
      const tempId = `temp_${room.id}_${s}`;
      activeJobs[tempId] = { room_id: room.id, style: s, status: 'generating' };
      tempCount++;
    }
  }

  if (tempCount === 0) {
    toast('Ingen billeder med valgte stilarter at generere', 'error');
    return;
  }

  // Hide sticky bar immediately
  document.getElementById('sticky-bar').classList.add('hidden');

  renderRooms();
  toast(`Genererer ${tempCount} billede${tempCount > 1 ? 'r' : ''}...`);

  const res = await fetch(`${API}/api/projects/${encodeURIComponent(currentProject.id)}/generate-all`, {
    method: 'POST',
  }).then(r => r.json());

  // Replace temp jobs with real ones
  for (const key of Object.keys(activeJobs)) {
    if (key.startsWith('temp_')) delete activeJobs[key];
  }
  for (const job of res) {
    activeJobs[job.job_id] = { room_id: job.room_id, style: job.style, status: 'generating' };
  }

  renderRooms();
  startPolling();
}

// ---------------------------------------------------------------------------
// Job polling
// ---------------------------------------------------------------------------

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollJobs, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  activeJobs = {};
}

async function pollJobs() {
  const pending = Object.keys(activeJobs).filter(id => activeJobs[id].status === 'generating');
  if (pending.length === 0) { stopPolling(); return; }

  let anyDone = false;

  for (const jobId of pending) {
    try {
      const job = await fetch(`${API}/api/jobs/${encodeURIComponent(jobId)}`).then(r => r.json());
      if (job.status === 'done') {
        activeJobs[jobId].status = 'done';
        const room = currentProject.rooms.find(r => r.id === job.room_id);
        if (room) {
          room.generated = room.generated || {};
          room.generated[job.style] = job.result;
        }
        anyDone = true;
        toast(`${styles[job.style]?.name || job.style} færdig!`, 'success');
      } else if (job.status === 'error') {
        activeJobs[jobId].status = 'error';
        anyDone = true;
        toast(`Fejl: ${job.error}`, 'error');
      }
    } catch (e) {
      // ignore network errors during polling
    }
  }

  if (anyDone) {
    renderRooms();
    updateResultsCount();
    if (currentTab === 'results') renderResultsGallery();
  }
}

// ---------------------------------------------------------------------------
// Result view
// ---------------------------------------------------------------------------

function showResult(roomId, initialStyle) {
  const room = currentProject.rooms.find(r => r.id === roomId);
  if (!room || !room.generated || Object.keys(room.generated).length === 0) return;

  const view = document.getElementById('result-view');
  const generatedStyles = Object.keys(room.generated);
  const activeStyle = initialStyle && generatedStyles.includes(initialStyle) ? initialStyle : generatedStyles[0];

  // Render tabs
  const tabsEl = document.getElementById('result-tabs');
  setHTML(tabsEl, generatedStyles.map(key =>
    `<div class="result-tab ${key === activeStyle ? 'active' : ''}" onclick="switchResultTab('${esc(roomId)}', '${esc(key)}')">${esc(styles[key]?.name || key)}</div>`
  ).join(''));

  // Render images
  document.getElementById('result-original').src = `/uploads/${encodeURIComponent(room.stored_filename)}`;
  document.getElementById('result-generated').src = `/generated/${encodeURIComponent(room.generated[activeStyle])}`;
  document.getElementById('result-room-title').textContent = `${roomTypes[room.room_type] || 'Rum'} — ${room.original_filename}`;
  document.getElementById('result-download').onclick = () => {
    const a = document.createElement('a');
    a.href = `/generated/${encodeURIComponent(room.generated[activeStyle])}`;
    a.download = `${currentProject.name}_${roomTypes[room.room_type] || 'rum'}_${styles[activeStyle]?.name || activeStyle}.png`;
    a.click();
  };

  view.classList.add('active');
}

function switchResultTab(roomId, styleKey) {
  const room = currentProject.rooms.find(r => r.id === roomId);
  if (!room) return;

  document.querySelectorAll('.result-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.result-tab').forEach(t => {
    if (t.textContent === (styles[styleKey]?.name || styleKey)) t.classList.add('active');
  });
  document.getElementById('result-generated').src = `/generated/${encodeURIComponent(room.generated[styleKey])}`;
  document.getElementById('result-download').onclick = () => {
    const a = document.createElement('a');
    a.href = `/generated/${encodeURIComponent(room.generated[styleKey])}`;
    a.download = `${currentProject.name}_${roomTypes[room.room_type] || 'rum'}_${styles[styleKey]?.name || styleKey}.png`;
    a.click();
  };
}

function closeResultView() {
  document.getElementById('result-view').classList.remove('active');
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function toast(message, type = '') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.remove(); }, 3500);
}

// ---------------------------------------------------------------------------
// Sticky generate bar
// ---------------------------------------------------------------------------

function updateStickyBar() {
  const bar = document.getElementById('sticky-bar');
  const textEl = document.getElementById('sticky-bar-text');
  if (!bar || !currentProject || currentTab !== 'edit') {
    if (bar) bar.classList.add('hidden');
    return;
  }

  const totalSelected = currentProject.rooms.reduce((sum, r) => sum + (r.selected_styles || []).length, 0);

  if (totalSelected > 0) {
    const roomsWithStyles = currentProject.rooms.filter(r => (r.selected_styles || []).length > 0).length;
    // Safe DOM construction
    textEl.textContent = '';
    const strong1 = document.createElement('strong');
    strong1.textContent = totalSelected;
    const strong2 = document.createElement('strong');
    strong2.textContent = roomsWithStyles;
    textEl.append(strong1, ` genereringer på `, strong2, ` billede${roomsWithStyles > 1 ? 'r' : ''}`);
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function initTooltip() {
  const tip = document.getElementById('custom-tooltip');
  document.addEventListener('mouseover', e => {
    const chip = e.target.closest('.style-chip');
    if (chip) {
      const styleKey = chip.dataset.style;
      const style = styles[styleKey];
      if (style && style.description) {
        tip.textContent = style.description;
        tip.classList.add('visible');
        positionTooltip(tip, chip);
      }
    }
  });
  document.addEventListener('mouseout', e => {
    const chip = e.target.closest('.style-chip');
    if (chip) {
      tip.classList.remove('visible');
    }
  });
}

function positionTooltip(tip, target) {
  const rect = target.getBoundingClientRect();
  tip.style.left = rect.left + rect.width / 2 - tip.offsetWidth / 2 + 'px';
  tip.style.top = rect.top - tip.offsetHeight - 8 + 'px';

  // Keep within viewport
  const tipRect = tip.getBoundingClientRect();
  if (tipRect.left < 8) tip.style.left = '8px';
  if (tipRect.right > window.innerWidth - 8) tip.style.left = (window.innerWidth - tip.offsetWidth - 8) + 'px';
  if (tipRect.top < 8) tip.style.top = rect.bottom + 8 + 'px';
}

document.addEventListener('DOMContentLoaded', initTooltip);

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('result-view').classList.remove('active');
    document.getElementById('modal-new-project').classList.remove('active');
  }
});
