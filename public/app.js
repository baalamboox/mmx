// ==========================================================================
// KORTEXA — APLICACIÓN CLIENTE (CON SOPORTE DE SUBCARPETAS Y ÁRBOL)
// ==========================================================================

// Estado global de la aplicación
const state = {
  notes: [],
  folders: [],
  activeNote: null,
  activeTab: 'editor', // 'editor' o 'graph'
  saveTimeout: null,
  graphInstance: null,
  theme: localStorage.getItem('kortexa-theme') || 'auto',
  openFolders: new Set(JSON.parse(localStorage.getItem('kortexa-open-folders') || '[]')),
  selectedFolder: '' // Carpeta activa para crear notas
};

function saveOpenFolders() {
  localStorage.setItem('kortexa-open-folders', JSON.stringify(Array.from(state.openFolders)));
}

// Persistencia de la nota activa por bóveda
function saveLastActiveNote(noteIdentifier) {
  if (!noteIdentifier) return;
  const vaultKey = state.activeVault ? `kortexa-last-note:${state.activeVault}` : 'kortexa-last-note';
  localStorage.setItem(vaultKey, noteIdentifier);
  localStorage.setItem('kortexa-last-note', noteIdentifier);
}

function getLastActiveNote() {
  const vaultKey = state.activeVault ? `kortexa-last-note:${state.activeVault}` : 'kortexa-last-note';
  return localStorage.getItem(vaultKey) || localStorage.getItem('kortexa-last-note');
}

function clearLastActiveNote() {
  if (state.activeVault) {
    localStorage.removeItem(`kortexa-last-note:${state.activeVault}`);
  }
  localStorage.removeItem('kortexa-last-note');
}

function restoreOrSelectDefaultNote() {
  if (!state.notes || state.notes.length === 0) return;

  const savedNote = getLastActiveNote();
  if (savedNote) {
    const existing = state.notes.find(n => n.filename === savedNote || n.title === savedNote);
    if (existing) {
      selectNote(existing.filename);
      return;
    }
  }

  const welcome = state.notes.find(n => n.title.toLowerCase().includes('bienvenida'));
  if (welcome) {
    selectNote(welcome.filename);
    return;
  }

  selectNote(state.notes[0].filename);
}

// Utilidad para escapar texto en plantillas HTML y evitar inyección o errores
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Elementos DOM
const notesListEl = document.getElementById('notes-list');
const notesCountEl = document.getElementById('notes-count');
const titleInputEl = document.getElementById('note-title-input');
const markdownInputEl = document.getElementById('markdown-input');
const markdownPreviewEl = document.getElementById('markdown-preview');
const saveStatusEl = document.getElementById('save-status');
const saveStatusContainerEl = document.getElementById('save-status-container');
const backlinksListEl = document.getElementById('backlinks-list');
const backlinksCountEl = document.getElementById('backlinks-count');
const searchInputEl = document.getElementById('search-input');
const editorWorkspaceEl = document.getElementById('editor-workspace');
const mediaViewerWorkspaceEl = document.getElementById('media-viewer-workspace');
const mediaViewerContentEl = document.getElementById('media-viewer-content');
const mediaFileInput = document.getElementById('media-file-input');
const modeTogglesEl = document.querySelector('.mode-toggles');
const markdownToolbarEl = document.getElementById('markdown-toolbar');
const toolbarHeadingSelect = document.getElementById('toolbar-heading-select');
const toolbarSizeSelect = document.getElementById('toolbar-size-select');

// Elementos de Carpeta en Editor
const noteFolderBadge = document.getElementById('note-folder-badge');
const noteFolderName = document.getElementById('note-folder-name');

// Selectores de tema
const themeBtnLight = document.getElementById('theme-btn-light');
const themeBtnDark = document.getElementById('theme-btn-dark');
const themeBtnAuto = document.getElementById('theme-btn-auto');

// Controles móviles (Drawer lateral)
const appSidebarEl = document.getElementById('app-sidebar');
const sidebarBackdropEl = document.getElementById('sidebar-backdrop');
const btnToggleSidebarEl = document.getElementById('btn-toggle-sidebar');
const btnCloseSidebarEl = document.getElementById('btn-close-sidebar');
const btnGraphMenuEl = document.getElementById('btn-graph-menu');

// Componente Modal y Toasts
const modalContainer = document.getElementById('modal-container');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalIconWrapper = document.getElementById('modal-icon-wrapper');
const modalIconSvg = document.getElementById('modal-icon-svg');
const modalInputContainer = document.getElementById('modal-input-container');
const modalInputField = document.getElementById('modal-input-field');
const modalBtnCancel = document.getElementById('modal-btn-cancel');
const modalBtnConfirm = document.getElementById('modal-btn-confirm');
const toastContainer = document.getElementById('toast-container');

// Modal Selector de Imágenes de la Bóveda
const imagePickerModal = document.getElementById('image-picker-modal');
const imagePickerGrid = document.getElementById('image-picker-grid');
const imagePickerSearch = document.getElementById('image-picker-search');
const btnConfirmImagePicker = document.getElementById('btn-confirm-image-picker');
const btnCloseImagePicker = document.getElementById('btn-close-image-picker');
const btnImagePickerUpload = document.getElementById('btn-image-picker-upload');
const btnImagePickerUrl = document.getElementById('btn-image-picker-url');
const imagePickerFileInput = document.getElementById('image-picker-file-input');
let selectedImageFile = null;

// Modal Selector de Videos
const videoPickerModal = document.getElementById('video-picker-modal');
const videoPickerGrid = document.getElementById('video-picker-grid');
const videoPickerSearch = document.getElementById('video-picker-search');
const btnConfirmVideoPicker = document.getElementById('btn-confirm-video-picker');
const btnCloseVideoPicker = document.getElementById('btn-close-video-picker');
const btnVideoPickerUpload = document.getElementById('btn-video-picker-upload');
const btnVideoPickerUrl = document.getElementById('btn-video-picker-url');
const videoPickerFileInput = document.getElementById('video-picker-file-input');
let selectedVideoFile = null;

// Modal FortuneSheet (Hojas de cálculo Excel)
const fortunesheetModal = document.getElementById('fortunesheet-modal');
const fortunesheetModalWorkbook = document.getElementById('fortunesheet-modal-workbook');
const btnSaveFortunesheetModal = document.getElementById('btn-save-fortunesheet-modal');
const btnCloseFortunesheetModal = document.getElementById('btn-close-fortunesheet-modal');
let activeModalFortuneSheetInstance = null;
let currentModalSheetBlockIndex = null;
const mountedSheetInstances = new Map();
let fortuneMountDebounceTimer = null;

// Modal Selector de Audios y Notas de Voz
const audioPickerModal = document.getElementById('audio-picker-modal');
const audioPickerGrid = document.getElementById('audio-picker-grid');
const audioPickerSearch = document.getElementById('audio-picker-search');
const btnConfirmAudioPicker = document.getElementById('btn-confirm-audio-picker');
const btnCloseAudioPicker = document.getElementById('btn-close-audio-picker');
const btnAudioPickerUpload = document.getElementById('btn-audio-picker-upload');
const btnAudioPickerRecord = document.getElementById('btn-audio-picker-record');
const audioPickerFileInput = document.getElementById('audio-picker-file-input');
let selectedAudioFile = null;

// Modal Grabadora de Notas de Voz
const voiceRecorderModal = document.getElementById('voice-recorder-modal');
const btnCloseVoiceRec = document.getElementById('btn-close-voice-rec');
const btnCancelVoiceRec = document.getElementById('btn-cancel-voice-rec');
const btnVoiceRecToggle = document.getElementById('btn-voice-rec-toggle');
const voiceRecBtnIcon = document.getElementById('voice-rec-btn-icon');
const btnVoiceRecPause = document.getElementById('btn-voice-rec-pause');
const voiceRecPauseText = document.getElementById('voice-rec-pause-text');
const btnVoiceRecDiscard = document.getElementById('btn-voice-rec-discard');
const btnSaveVoiceRec = document.getElementById('btn-save-voice-rec');
const voiceRecDisplay = document.getElementById('voice-rec-display');
const voiceRecButtonWrap = document.getElementById('voice-rec-button-wrap');
const recVuMeter = document.getElementById('rec-vu-meter');
const voiceRecTimerEl = document.getElementById('voice-rec-timer');
const voiceRecVisualizerCanvas = document.getElementById('voice-rec-visualizer');
const voiceRecBadgePill = document.getElementById('voice-rec-badge-pill');
const voiceRecStatusText = document.getElementById('voice-rec-status-text');
const voiceRecSubControls = document.getElementById('voice-rec-sub-controls');
const voiceRecPreviewPanel = document.getElementById('voice-rec-preview-panel');
const voiceRecAudioPreview = document.getElementById('voice-rec-audio-preview');
const inputVoiceRecName = document.getElementById('input-voice-rec-name');
const voiceRecExtTag = document.getElementById('voice-rec-ext-tag');

// Estado interno de la grabadora de voz
let mediaRecorder = null;
let audioChunks = [];
let voiceRecStream = null;
let voiceRecTimerInterval = null;
let voiceRecSeconds = 0;
let voiceRecState = 'idle'; // 'idle', 'recording', 'paused', 'stopped'
let recordedAudioBlob = null;
let recordedMimeType = 'audio/webm';
let audioCtx = null;
let analyserNode = null;
let visualizerAnimFrame = null;

// Botones de control
const btnNewNote = document.getElementById('btn-new-note');
const btnNewFolder = document.getElementById('btn-new-folder');
const btnCollapseAll = document.getElementById('btn-collapse-all');
const btnRenameVault = document.getElementById('btn-rename-vault');
const btnAddVault = document.getElementById('btn-add-vault');
const btnDeleteVault = document.getElementById('btn-delete-vault');
const btnLockVault = document.getElementById('btn-lock-vault');
const customVaultDropdown = document.getElementById('custom-vault-dropdown');
const vaultDropdownTrigger = document.getElementById('vault-dropdown-trigger');
const vaultDropdownLabel = document.getElementById('vault-dropdown-label');
const vaultDropdownMenu = document.getElementById('vault-dropdown-menu');
const vaultMoreDropdown = document.getElementById('vault-more-dropdown');
const btnVaultMore = document.getElementById('btn-vault-more');
const vaultMoreMenu = document.getElementById('vault-more-menu');
const btnManageVault = document.getElementById('btn-manage-vault');
const vaultManagerModal = document.getElementById('vault-manager-modal');
const vaultsListContainer = document.getElementById('vaults-list-container');
const btnVaultManagerNew = document.getElementById('btn-vault-manager-new');
const btnVaultManagerSecurity = document.getElementById('btn-vault-manager-security');
const btnCloseVaultManager = document.getElementById('btn-close-vault-manager');
const treeVaultName = document.getElementById('tree-vault-name');
const vaultStatusIndicator = document.getElementById('vault-status-indicator');
const vaultLockScreen = document.getElementById('vault-lock-screen');
const formUnlockVault = document.getElementById('form-unlock-vault');
const inputVaultPassword = document.getElementById('input-vault-password');
const btnToggleLockPwd = document.getElementById('btn-toggle-lock-pwd');
const lockEyeIcon = document.getElementById('lock-eye-icon');
const lockErrorBanner = document.getElementById('lock-error-banner');
const lockVaultName = document.getElementById('lock-vault-name');
const btnLockSwitchOther = document.getElementById('btn-lock-switch-other');
const btnDeleteNote = document.getElementById('btn-delete-note');
const navEditorBtn = document.getElementById('nav-editor');
const navGraphBtn = document.getElementById('nav-graph');
const viewEditor = document.getElementById('view-editor');
const viewGraph = document.getElementById('view-graph');

const btnModeSplit = document.getElementById('btn-mode-split');
const btnModePreview = document.getElementById('btn-mode-preview');
const btnModeEdit = document.getElementById('btn-mode-edit');

// ==========================================
// 1. INICIALIZACIÓN
// ==========================================
async function init() {
  applyTheme(state.theme);
  setupEventListeners();
  const isUnlocked = await loadVaultInfo();
  if (isUnlocked) {
    await loadNotesAndFolders();
    restoreOrSelectDefaultNote();
  }
}

// ==========================================
// 2. LLAMADAS A LA API Y PERSISTENCIA
// ==========================================
async function loadVaultInfo() {
  try {
    const [res, vaultsRes] = await Promise.all([
      fetch('/api/vault'),
      fetch('/api/vaults')
    ]);
    if (!res.ok) return false;
    const data = await res.json();
    const vaultsData = vaultsRes.ok ? await vaultsRes.json() : null;

    state.activeVault = data.name;
    state.isVaultEncrypted = !!data.encrypted;
    state.isVaultLocked = !!data.locked;

    const vaultNameEl = document.getElementById('vault-display-name');
    const treeVaultEl = document.getElementById('tree-vault-name');
    const vaultIndicatorEl = document.getElementById('vault-status-indicator');

    if (vaultNameEl) vaultNameEl.textContent = data.name;
    if (treeVaultEl) treeVaultEl.textContent = data.name.toUpperCase();
    if (vaultIndicatorEl) {
      const lockLabel = data.encrypted ? ' (Protegida AES-256)' : '';
      vaultIndicatorEl.title = `Bóveda activa: ${data.name}${lockLabel} (${data.path}) - Clic para gestionar`;
    }

    // Actualizar botones de candado
    updateLockButtons(data.encrypted, data.locked);

    // Actualizar nombre en trigger del dropdown personalizado
    if (vaultDropdownLabel) {
      vaultDropdownLabel.textContent = data.name;
      vaultDropdownLabel.title = `Bóveda activa: ${data.name}`;
    }

    // Actualizar items del dropdown personalizado de bóvedas
    if (vaultDropdownMenu && vaultsData && Array.isArray(vaultsData.vaults)) {
      vaultDropdownMenu.innerHTML = '';

      vaultsData.vaults.forEach(v => {
        const item = document.createElement('div');
        item.className = `custom-vault-item ${v.isActive ? 'active' : ''}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', v.isActive ? 'true' : 'false');
        item.title = `Cambiar a la bóveda "${v.name}"`;

        const encIcon = v.isEncrypted
          ? `<span class="custom-vault-item-lock" title="Cifrado AES-256">
               <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                 <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
               </svg>
             </span>`
          : '';

        item.innerHTML = `
          <div class="custom-vault-item-left">
            <svg class="custom-vault-item-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="20" rx="4"/>
              <circle cx="12" cy="12" r="4"/>
            </svg>
            <span class="custom-vault-item-name">${escapeHtml(v.name)}</span>
            <span class="custom-vault-item-badge">${v.filesCount}</span>
          </div>
          <div class="custom-vault-item-right">
            ${encIcon}
            <svg class="custom-vault-item-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
        `;

        item.addEventListener('click', async (e) => {
          e.stopPropagation();
          closeVaultDropdown();
          if (!v.isActive) {
            await switchVault(v.name);
          }
        });

        vaultDropdownMenu.appendChild(item);
      });

      // Divisor
      const divider = document.createElement('div');
      divider.className = 'custom-vault-divider';
      vaultDropdownMenu.appendChild(divider);

      // Acción rápida: Nueva Bóveda
      const newVaultAction = document.createElement('div');
      newVaultAction.className = 'custom-vault-action-item';
      newVaultAction.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        <span>Nueva Bóveda...</span>
      `;
      newVaultAction.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeVaultDropdown();
        await createNewVault();
      });
      vaultDropdownMenu.appendChild(newVaultAction);

      // Acción rápida: Administrar Bóvedas
      const manageAction = document.createElement('div');
      manageAction.className = 'custom-vault-action-item';
      manageAction.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span>Gestionar Bóvedas...</span>
      `;
      manageAction.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeVaultDropdown();
        await openVaultManagerModal();
      });
      vaultDropdownMenu.appendChild(manageAction);
    }

    if (data.locked) {
      showLockScreen(data.name);
      return false;
    } else {
      hideLockScreen();
      return true;
    }
  } catch (err) {
    console.warn('No se pudo obtener información de la bóveda:', err);
    return false;
  }
}

function updateLockButtons(encrypted, locked) {
  const lockSvg = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  `;
  const unlockSvg = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
    </svg>
  `;

  // Item en el menú emergente
  if (btnLockVault) {
    const iconEl = document.getElementById('btn-lock-vault-icon');
    const textEl = document.getElementById('btn-lock-vault-text');
    if (iconEl) {
      iconEl.innerHTML = (encrypted && locked) ? lockSvg : (encrypted ? unlockSvg : lockSvg);
    }
    if (textEl) {
      if (!encrypted) {
        textEl.textContent = 'Proteger y Cifrar (AES-256)';
      } else if (locked) {
        textEl.textContent = 'Desbloquear Bóveda';
      } else {
        textEl.textContent = 'Bloquear Bóveda (AES-256)';
      }
    }
    btnLockVault.title = encrypted
      ? (locked ? 'Bóveda Cifrada y Bloqueada (Clic para desbloquear)' : 'Bloquear Bóveda (Ctrl+L o Clic)')
      : 'Cifrar Bóveda con Contraseña (AES-256)';
  }
}

function showLockScreen(vaultName) {
  if (!vaultLockScreen) return;
  vaultLockScreen.style.display = 'flex';
  vaultLockScreen.setAttribute('aria-hidden', 'false');
  if (lockVaultName) lockVaultName.textContent = vaultName || 'Bóveda';
  if (inputVaultPassword) {
    inputVaultPassword.value = '';
    setTimeout(() => inputVaultPassword.focus(), 60);
  }
  if (lockErrorBanner) {
    lockErrorBanner.style.display = 'none';
    lockErrorBanner.textContent = '';
  }
}

function hideLockScreen() {
  if (!vaultLockScreen) return;
  vaultLockScreen.style.display = 'none';
  vaultLockScreen.setAttribute('aria-hidden', 'true');
  if (inputVaultPassword) inputVaultPassword.value = '';
}

async function unlockActiveVault(password) {
  try {
    const res = await fetch('/api/vault/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) {
      if (lockErrorBanner) {
        lockErrorBanner.textContent = data.error || 'Contraseña incorrecta';
        lockErrorBanner.style.display = 'block';
      }
      return;
    }

    hideLockScreen();
    showToast('Bóveda descifrada y desbloqueada', 'success');
    await loadVaultInfo();
    await loadNotesAndFolders();
    restoreOrSelectDefaultNote();
  } catch (err) {
    console.error('Error desbloqueando bóveda:', err);
    if (lockErrorBanner) {
      lockErrorBanner.textContent = 'Error de conexión con el servidor';
      lockErrorBanner.style.display = 'block';
    }
  }
}

async function lockActiveVault() {
  if (!state.isVaultEncrypted) {
    await manageVaultSecurity();
    return;
  }
  try {
    const res = await fetch('/api/vault/lock', { method: 'POST' });
    state.isVaultLocked = true;
    showLockScreen(state.activeVault || 'vault');
    showToast('Bóveda bloqueada', 'info');
    updateLockButtons(true, true);
  } catch (err) {
    console.error('Error bloqueando bóveda:', err);
  }
}

async function manageVaultSecurity() {
  const currentVault = state.activeVault || 'vault';
  if (state.isVaultEncrypted) {
    const pwd = await showPromptModal({
      title: 'Desactivar Cifrado de Bóveda',
      message: `La bóveda "${currentVault}" está cifrada con AES-256-GCM.\nPara descifrar todos los archivos de vuelta a texto plano en disco, ingrese su contraseña actual:`,
      placeholder: 'Contraseña maestra actual...',
      defaultValue: '',
      confirmText: 'Descifrar Bóveda',
      cancelText: 'Cancelar'
    });

    if (!pwd) return;

    try {
      const res = await fetch('/api/vault/decrypt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Error al descifrar', 'danger');
        return;
      }
      showToast(data.message || 'Bóveda descifrada a texto plano', 'success');
      await loadVaultInfo();
      await loadNotesAndFolders();
      if (vaultManagerModal?.classList.contains('active')) {
        await openVaultManagerModal();
      }
    } catch (err) {
      showToast('Error al conectar con el servidor', 'danger');
    }
  } else {
    const pwd = await showPromptModal({
      title: 'Proteger y Cifrar Bóveda (AES-256)',
      message: `Todos los archivos de la bóveda "${currentVault}" se cifrarán físicamente en disco con AES-256-GCM.\nIngrese una contraseña maestra para protegerla:`,
      placeholder: 'Mínimo 4 caracteres...',
      defaultValue: '',
      confirmText: 'Cifrar Bóveda',
      cancelText: 'Cancelar'
    });

    if (!pwd) return;
    if (pwd.length < 4) {
      showToast('La contraseña debe tener al menos 4 caracteres', 'danger');
      return;
    }

    try {
      const res = await fetch('/api/vault/encrypt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Error al cifrar', 'danger');
        return;
      }
      showToast(data.message || 'Bóveda protegida con AES-256-GCM', 'success');
      await loadVaultInfo();
      await loadNotesAndFolders();
      if (vaultManagerModal?.classList.contains('active')) {
        await openVaultManagerModal();
      }
    } catch (err) {
      showToast('Error al conectar con el servidor', 'danger');
    }
  }
}

async function renameVault() {
  const currentName = document.getElementById('vault-display-name')?.textContent || 'vault';
  const newName = await showPromptModal({
    title: 'Renombrar Bóveda',
    message: `Ingresa el nuevo nombre para la carpeta de la bóveda:`,
    placeholder: 'Ej. MiBoveda, Notas-Personales...',
    defaultValue: currentName,
    confirmText: 'Renombrar',
    cancelText: 'Cancelar'
  });

  if (!newName || newName.trim() === '' || newName.trim() === currentName) {
    return;
  }

  const cleanName = newName.trim();

  try {
    const res = await fetch('/api/vault/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: cleanName })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Error al renombrar la bóveda', 'danger');
      return;
    }

    showToast(`Bóveda renombrada a "${data.name}"`, 'success');
    await loadVaultInfo();
    await loadNotesAndFolders();
  } catch (err) {
    console.error('Error al renombrar la bóveda:', err);
    showToast('Error de conexión al renombrar la bóveda', 'danger');
  }
}

async function createNewVault() {
  const newName = await showPromptModal({
    title: 'Crear Nueva Bóveda',
    message: 'Ingresa el nombre para la nueva bóveda independiente:',
    placeholder: 'Ej. Proyectos, Personal, Trabajo...',
    defaultValue: '',
    confirmText: 'Crear Bóveda',
    cancelText: 'Cancelar'
  });

  if (!newName || !newName.trim()) return;

  const cleanName = newName.trim();
  try {
    const res = await fetch('/api/vaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName, switchNow: true })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Error al crear la bóveda', 'danger');
      return;
    }

    showToast(`Bóveda "${data.name}" creada y activada`, 'success');
    closeVaultManagerModal();
    await loadVaultInfo();
    await loadNotesAndFolders();

    if (state.notes.length > 0) {
      selectNote(state.notes[0].filename);
    }
    if (state.activeTab === 'graph') {
      renderGraph();
    }
  } catch (err) {
    console.error('Error al crear bóveda:', err);
    showToast('Error de conexión al crear la bóveda', 'danger');
  }
}

async function switchVault(vaultName) {
  try {
    const res = await fetch('/api/vault/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: vaultName })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Error al cambiar de bóveda', 'danger');
      return;
    }

    showToast(`Bóveda cambiada a "${data.name}"`, 'info');
    closeVaultManagerModal();
    await loadVaultInfo();
    await loadNotesAndFolders();
    restoreOrSelectDefaultNote();
    if (state.activeTab === 'graph') {
      renderGraph();
    }
  } catch (err) {
    console.error('Error al cambiar de bóveda:', err);
    showToast('Error de conexión al cambiar de bóveda', 'danger');
  }
}

async function openVaultManagerModal() {
  if (!vaultManagerModal || !vaultsListContainer) return;
  try {
    const res = await fetch('/api/vaults');
    if (!res.ok) return;
    const data = await res.json();
    
    vaultsListContainer.innerHTML = '';
    if (!data.vaults || data.vaults.length === 0) {
      vaultsListContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 12px; padding: 12px 0;">No se encontraron bóvedas registradas.</p>';
    } else {
      data.vaults.forEach(v => {
        const row = document.createElement('div');
        row.className = `vault-item-row ${v.isActive ? 'active' : ''}`;
        row.title = v.isActive ? `Bóveda activa actual: ${v.name}` : `Clic para cambiar a bóveda "${v.name}"`;
        const securityBadge = v.isEncrypted 
          ? `<span class="vault-security-badge encrypted" title="Cifrada físicamente con AES-256-GCM">🔒 AES-256</span>`
          : `<span class="vault-security-badge plain" title="Sin cifrar">🔓 Plano</span>`;

        row.innerHTML = `
          <div class="vault-item-info">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="${v.isActive ? 'var(--cyan-core)' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="20" rx="4"/>
              <circle cx="12" cy="12" r="4"/>
            </svg>
            <span class="vault-item-name">${escapeHtml(v.name)}</span>
            ${v.isActive ? '<span class="vault-item-badge">ACTIVA</span>' : ''}
            ${securityBadge}
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="vault-item-count">${v.filesCount} archivo(s)</span>
            <button class="vault-row-delete-btn" title="Eliminar bóveda &quot;${escapeHtml(v.name)}&quot;" aria-label="Eliminar bóveda">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                <line x1="10" y1="11" x2="10" y2="17"/>
                <line x1="14" y1="11" x2="14" y2="17"/>
              </svg>
            </button>
            ${!v.isActive ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>' : ''}
          </div>
        `;

        const deleteBtn = row.querySelector('.vault-row-delete-btn');
        deleteBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteVault(v.name);
        });

        row.addEventListener('click', () => {
          if (!v.isActive) {
            switchVault(v.name);
          }
        });
        vaultsListContainer.appendChild(row);
      });
    }

    vaultManagerModal.classList.add('active');
  } catch (err) {
    console.error('Error al abrir gestor de bóvedas:', err);
  }
}

async function deleteVault(vaultName) {
  const confirmed = await showConfirmModal({
    title: '¿Eliminar Bóveda?',
    message: `¿Estás seguro de que deseas eliminar permanentemente la bóveda "${vaultName}" y todo su contenido en disco?\nEsta acción es irreversible y borrará todos los archivos de esa bóveda.`,
    confirmText: 'Eliminar Bóveda',
    cancelText: 'Cancelar',
    danger: true,
    icon: 'trash'
  });

  if (!confirmed) return;

  try {
    const res = await fetch(`/api/vaults?name=${encodeURIComponent(vaultName)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Error al eliminar la bóveda', 'danger');
      return;
    }

    showToast(`Bóveda "${vaultName}" eliminada con éxito`, 'danger');
    await loadVaultInfo();
    await loadNotesAndFolders();
    await openVaultManagerModal();

    if (state.notes.length > 0) {
      selectNote(state.notes[0].filename);
    }
    if (state.activeTab === 'graph') {
      renderGraph();
    }
  } catch (err) {
    console.error('Error al eliminar bóveda:', err);
    showToast('Error de conexión al eliminar la bóveda', 'danger');
  }
}

function toggleVaultDropdown() {
  if (!customVaultDropdown) return;
  const isOpen = customVaultDropdown.classList.contains('open');
  if (isOpen) {
    closeVaultDropdown();
  } else {
    closeVaultMoreMenu();
    customVaultDropdown.classList.add('open');
    vaultDropdownTrigger?.setAttribute('aria-expanded', 'true');
  }
}

function closeVaultDropdown() {
  if (!customVaultDropdown) return;
  customVaultDropdown.classList.remove('open');
  vaultDropdownTrigger?.setAttribute('aria-expanded', 'false');
}

function toggleVaultMoreMenu() {
  if (!vaultMoreDropdown) return;
  const isOpen = vaultMoreDropdown.classList.contains('open');
  if (isOpen) {
    closeVaultMoreMenu();
  } else {
    closeVaultDropdown();
    vaultMoreDropdown.classList.add('open');
    btnVaultMore?.setAttribute('aria-expanded', 'true');
  }
}

function closeVaultMoreMenu() {
  if (!vaultMoreDropdown) return;
  vaultMoreDropdown.classList.remove('open');
  btnVaultMore?.setAttribute('aria-expanded', 'false');
}

function closeVaultManagerModal() {
  vaultManagerModal?.classList.remove('active');
}

async function loadNotesAndFolders() {
  try {
    const [notesRes, foldersRes] = await Promise.all([
      fetch('/api/notes'),
      fetch('/api/folders')
    ]);

    if (notesRes.status === 423 || foldersRes.status === 423) {
      showLockScreen(state.activeVault || 'vault');
      return;
    }

    state.notes = await notesRes.json();
    state.folders = await foldersRes.json();

    renderTree(state.notes, state.folders);
  } catch (err) {
    console.error('Error cargando notas y carpetas:', err);
  }
}

async function selectNote(noteIdentifier) {
  try {
    // Si viene solo el título o la ruta completa, consultamos la API
    const res = await fetch(`/api/note?path=${encodeURIComponent(noteIdentifier)}&title=${encodeURIComponent(noteIdentifier)}`);
    if (!res.ok) {
      if (res.status === 404) {
        // La nota no existe aún (ej. enlazada con [[]]) -> la preparamos en la carpeta seleccionada o raíz
        const rawName = noteIdentifier.replace(/\.md$/, '');
        const lastSlash = rawName.lastIndexOf('/');
        const cleanTitle = lastSlash !== -1 ? rawName.slice(lastSlash + 1) : rawName;
        const targetFolder = lastSlash !== -1 ? rawName.slice(0, lastSlash) : (state.selectedFolder || '');
        const filename = targetFolder ? `${targetFolder}/${cleanTitle}.md` : `${cleanTitle}.md`;
        state.activeNote = { 
          title: cleanTitle, 
          filename, 
          name: `${cleanTitle}.md`,
          type: 'note',
          folder: targetFolder, 
          content: `# ${cleanTitle}\n\n` 
        };
      } else {
        return;
      }
    } else {
      state.activeNote = await res.json();
    }

    if (state.activeNote && state.activeNote.filename) {
      saveLastActiveNote(state.activeNote.filename);
    }

    const isMedia = state.activeNote.type && state.activeNote.type !== 'note';

    titleInputEl.value = state.activeNote.title || state.activeNote.name || '';
    titleInputEl.readOnly = isMedia;
    noteFolderName.textContent = state.activeNote.folder || 'Raíz';

    if (isMedia) {
      if (editorWorkspaceEl) editorWorkspaceEl.style.display = 'none';
      if (modeTogglesEl) modeTogglesEl.style.display = 'none';
      if (saveStatusContainerEl) saveStatusContainerEl.style.display = 'none';
      if (markdownToolbarEl) markdownToolbarEl.style.display = 'none';
      if (mediaViewerWorkspaceEl) mediaViewerWorkspaceEl.style.display = 'flex';
      renderMediaViewer(state.activeNote);
    } else {
      if (mediaViewerWorkspaceEl) mediaViewerWorkspaceEl.style.display = 'none';
      if (editorWorkspaceEl) editorWorkspaceEl.style.display = '';
      if (modeTogglesEl) modeTogglesEl.style.display = 'flex';
      if (saveStatusContainerEl) saveStatusContainerEl.style.display = 'flex';
      if (markdownToolbarEl) {
        markdownToolbarEl.style.display = (editorWorkspaceEl && editorWorkspaceEl.classList.contains('preview-mode')) ? 'none' : 'flex';
      }
      markdownInputEl.value = state.activeNote.content || '';
      renderMarkdown();
      setSaveStatus('Guardado');
    }

    // Abrir automáticamente la carpeta contenedora en el árbol
    if (state.activeNote.folder) {
      let currentPath = '';
      const parts = state.activeNote.folder.split('/');
      parts.forEach(part => {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        state.openFolders.add(currentPath);
      });
      saveOpenFolders();
    }

    loadBacklinks(state.activeNote.title || state.activeNote.name);
    renderTree(state.notes, state.folders);

    // Cerrar drawer lateral en vista móvil al seleccionar una nota
    closeMobileSidebar();

    // Cambiar a vista editor si estábamos en grafo
    if (state.activeTab !== 'editor') {
      switchTab('editor');
    }
  } catch (err) {
    console.error('Error al seleccionar nota:', err);
  }
}

async function saveCurrentNote() {
  if (!state.activeNote || (state.activeNote.type && state.activeNote.type !== 'note')) return;

  const currentTitle = titleInputEl.value.trim() || 'Sin Título';
  const currentContent = markdownInputEl.value;

  setSaveStatus('Guardando...', true);

  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: currentTitle,
        folder: state.activeNote.folder || '',
        oldPath: state.activeNote.filename,
        content: currentContent
      })
    });

    const saved = await res.json();
    state.activeNote = saved;
    noteFolderName.textContent = saved.folder || 'Raíz';
    if (saved && saved.filename) {
      saveLastActiveNote(saved.filename);
    }
    if (saved && saved.filename) {
      saveLastActiveNote(saved.filename);
    }

    setSaveStatus('Guardado');
    await loadNotesAndFolders();
    loadBacklinks(saved.title);
  } catch (err) {
    setSaveStatus('Error al guardar');
    showToast('Error al guardar la nota en la bóveda', 'danger');
    console.error('Error guardando:', err);
  }
}

// ==========================================
// 3. COMPONENTE MODAL DE ALERTAS Y TOASTS
// ==========================================
function showConfirmModal({
  title = '¿Confirmar acción?',
  message = '¿Estás seguro de continuar?',
  confirmText = 'Confirmar',
  cancelText = 'Cancelar',
  danger = true,
  icon = 'trash'
} = {}) {
  return new Promise((resolve) => {
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalBtnConfirm.textContent = confirmText;
    modalBtnCancel.textContent = cancelText;
    modalInputContainer.style.display = 'none';

    modalBtnConfirm.className = danger ? 'modal-btn danger' : 'modal-btn primary';
    modalIconWrapper.className = danger ? 'modal-icon-badge danger' : 'modal-icon-badge info';

    if (icon === 'trash') {
      modalIconSvg.innerHTML = `
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        <line x1="10" y1="11" x2="10" y2="17"/>
        <line x1="14" y1="11" x2="14" y2="17"/>
      `;
    } else {
      modalIconSvg.innerHTML = `
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      `;
    }

    modalContainer.classList.add('active');
    modalBtnConfirm.focus();

    function cleanup(result) {
      modalContainer.classList.remove('active');
      modalBtnConfirm.removeEventListener('click', onConfirm);
      modalBtnCancel.removeEventListener('click', onCancel);
      modalContainer.removeEventListener('click', onBackdrop);
      window.removeEventListener('keydown', onKeyDown);
      resolve(result);
    }

    function onConfirm() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) {
      if (e.target === modalContainer) cleanup(false);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') cleanup(true);
    }

    modalBtnConfirm.addEventListener('click', onConfirm);
    modalBtnCancel.addEventListener('click', onCancel);
    modalContainer.addEventListener('click', onBackdrop);
    window.addEventListener('keydown', onKeyDown);
  });
}

function showPromptModal({
  title = 'Ingresar información',
  message = 'Por favor ingresa un valor:',
  placeholder = '',
  defaultValue = '',
  confirmText = 'Aceptar',
  cancelText = 'Cancelar'
} = {}) {
  return new Promise((resolve) => {
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalBtnConfirm.textContent = confirmText;
    modalBtnCancel.textContent = cancelText;

    modalIconWrapper.className = 'modal-icon-badge info';
    modalIconSvg.innerHTML = `
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      <line x1="12" y1="11" x2="12" y2="17"/>
      <line x1="9" y1="14" x2="15" y2="14"/>
    `;

    modalBtnConfirm.className = 'modal-btn primary';
    modalInputContainer.style.display = 'block';
    modalInputField.value = defaultValue;
    modalInputField.placeholder = placeholder;

    modalContainer.classList.add('active');
    setTimeout(() => {
      modalInputField.focus();
      modalInputField.select();
    }, 50);

    function cleanup(result) {
      modalContainer.classList.remove('active');
      modalInputContainer.style.display = 'none';
      modalBtnConfirm.removeEventListener('click', onConfirm);
      modalBtnCancel.removeEventListener('click', onCancel);
      modalContainer.removeEventListener('click', onBackdrop);
      window.removeEventListener('keydown', onKeyDown);
      resolve(result);
    }

    function onConfirm() { 
      cleanup(modalInputField.value.trim()); 
    }
    function onCancel() { 
      cleanup(null); 
    }
    function onBackdrop(e) {
      if (e.target === modalContainer) cleanup(null);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') cleanup(null);
      if (e.key === 'Enter') cleanup(modalInputField.value.trim());
    }

    modalBtnConfirm.addEventListener('click', onConfirm);
    modalBtnCancel.addEventListener('click', onCancel);
    modalContainer.addEventListener('click', onBackdrop);
    window.addEventListener('keydown', onKeyDown);
  });
}

function showToast(message, type = 'info', duration = 3000) {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = `toast-item ${type}`;

  const iconMap = {
    danger: '✕',
    success: '✓',
    info: '✦'
  };

  toast.innerHTML = `
    <span style="font-weight: 700; color: var(--${type === 'info' ? 'cyan-core' : type}); font-size: 14px;">${iconMap[type] || '✦'}</span>
    <span>${message}</span>
  `;

  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// Eliminar nota o archivo multimedia actual
async function deleteCurrentNote() {
  if (!state.activeNote) return;

  const isMedia = state.activeNote.type && state.activeNote.type !== 'note';
  const itemLabel = isMedia ? 'archivo multimedia' : 'pensamiento';

  const confirmed = await showConfirmModal({
    title: isMedia ? 'Eliminar Archivo' : 'Eliminar Pensamiento',
    message: `¿Estás seguro de que deseas eliminar permanentemente "${state.activeNote.name || state.activeNote.title}"? Esta acción borrará el archivo físico de tu bóveda.`,
    confirmText: 'Eliminar',
    cancelText: 'Cancelar',
    danger: true,
    icon: 'trash'
  });

  if (!confirmed) return;

  const deletedTitle = state.activeNote.name || state.activeNote.title;

  try {
    await fetch(`/api/notes?path=${encodeURIComponent(state.activeNote.filename)}`, {
      method: 'DELETE'
    });

    showToast(`"${deletedTitle}" eliminado`, 'danger');
    state.activeNote = null;
    clearLastActiveNote();
    await loadNotesAndFolders();

    if (state.notes.length > 0) {
      restoreOrSelectDefaultNote();
    } else {
      titleInputEl.value = '';
      markdownInputEl.value = '';
      markdownPreviewEl.innerHTML = '';
      if (mediaViewerWorkspaceEl) mediaViewerWorkspaceEl.style.display = 'none';
      if (editorWorkspaceEl) editorWorkspaceEl.style.display = '';
      backlinksListEl.innerHTML = '';
      backlinksCountEl.textContent = '0';
      noteFolderName.textContent = 'Raíz';
    }
  } catch (err) {
    showToast('Error al eliminar el archivo de la bóveda', 'danger');
  }
}

// Crear nueva carpeta (admite targetParent opcional, o usa la carpeta seleccionada/activa)
async function createNewFolder(targetParent) {
  const parent = (typeof targetParent === 'string')
    ? targetParent
    : (state.selectedFolder || (state.activeNote ? state.activeNote.folder : ''));

  const promptTitle = parent ? 'Nueva Subcarpeta' : 'Nueva Carpeta';
  const promptMessage = parent 
    ? `Crear subcarpeta dentro de "${parent}":`
    : 'Ingresa el nombre de la carpeta (ej. "Proyectos" o "Trabajo/2026"):';

  const folderName = await showPromptModal({
    title: promptTitle,
    message: promptMessage,
    placeholder: parent ? `Nombre dentro de ${parent}...` : 'Nombre de la carpeta...'
  });

  if (!folderName) return;

  const cleanName = folderName.replace(/^[/\\]+|[/\\]+$/g, '');
  const fullFolderPath = parent ? `${parent}/${cleanName}` : cleanName;

  try {
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: fullFolderPath })
    });

    const data = await res.json();
    state.openFolders.add(data.folder);
    if (parent) state.openFolders.add(parent);
    state.selectedFolder = data.folder;
    saveOpenFolders();

    showToast(`Carpeta "${data.folder}" creada`, 'success');
    await loadNotesAndFolders();
  } catch (err) {
    showToast('Error al crear la carpeta', 'danger');
  }
}

// Colapsar todas las carpetas del árbol
function collapseAllFolders() {
  state.openFolders.clear();
  state.selectedFolder = '';
  saveOpenFolders();
  renderTree(state.notes, state.folders);
  showToast('Todas las carpetas colapsadas', 'info', 1500);
}

// Crear nueva nota en una carpeta específica o la activa
function createNewNoteInFolder(targetFolder) {
  state.selectedFolder = targetFolder || '';
  if (targetFolder) state.openFolders.add(targetFolder);
  saveOpenFolders();

  const newTitle = `Nota sin título ${state.notes.length + 1}`;
  const filename = targetFolder ? `${targetFolder}/${newTitle}.md` : `${newTitle}.md`;

  selectNote(filename);
  switchTab('editor');

  if (window.innerWidth <= 768) {
    sidebarEl?.classList.remove('open');
    sidebarBackdrop?.classList.remove('active');
  }

  setTimeout(() => {
    titleInputEl.focus();
    titleInputEl.select();
  }, 100);
}

// Menú contextual flotante para acciones de carpeta
let activeFolderMenu = null;

function closeFolderMenu() {
  if (activeFolderMenu) {
    document.querySelectorAll('.folder-header.menu-open').forEach(h => h.classList.remove('menu-open'));
    activeFolderMenu.remove();
    activeFolderMenu = null;
  }
}

function showFolderActionMenu(buttonEl, folderPath, folderName) {
  const parentHeader = buttonEl.closest('.folder-header');
  
  if (activeFolderMenu && activeFolderMenu.dataset.folder === folderPath) {
    closeFolderMenu();
    return;
  }
  closeFolderMenu();

  if (parentHeader) parentHeader.classList.add('menu-open');

  const rect = buttonEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'folder-action-menu';
  menu.dataset.folder = folderPath;

  menu.innerHTML = `
    <div class="folder-menu-header">
      <span>En "${folderName}"</span>
    </div>
    <button class="folder-menu-item" id="menu-opt-note">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="12" y1="18" x2="12" y2="12"/>
        <line x1="9" y1="15" x2="15" y2="15"/>
      </svg>
      <span>Nueva Nota (.md)</span>
    </button>
    <button class="folder-menu-item" id="menu-opt-folder">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        <line x1="12" y1="11" x2="12" y2="17"/>
        <line x1="9" y1="14" x2="15" y2="14"/>
      </svg>
      <span>Nueva Subcarpeta</span>
    </button>
    <button class="folder-menu-item" id="menu-opt-upload">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <span>Subir Multimedia...</span>
    </button>
  `;

  document.body.appendChild(menu);
  activeFolderMenu = menu;

  const menuWidth = 185;
  let top = rect.bottom + 6;
  let left = rect.right - menuWidth;

  if (left < 10) left = 10;
  if (left + menuWidth > window.innerWidth - 10) {
    left = window.innerWidth - menuWidth - 10;
  }
  if (top + 130 > window.innerHeight) {
    top = Math.max(10, rect.top - 120);
  }

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  requestAnimationFrame(() => menu.classList.add('visible'));

  menu.querySelector('#menu-opt-note').addEventListener('click', (e) => {
    e.stopPropagation();
    closeFolderMenu();
    createNewNoteInFolder(folderPath);
  });

  menu.querySelector('#menu-opt-folder').addEventListener('click', (e) => {
    e.stopPropagation();
    closeFolderMenu();
    createNewFolder(folderPath);
  });

  menu.querySelector('#menu-opt-upload').addEventListener('click', (e) => {
    e.stopPropagation();
    closeFolderMenu();
    if (mediaFileInput) {
      mediaFileInput.dataset.targetFolder = folderPath;
      mediaFileInput.click();
    }
  });
}

// ==========================================
// UTILIDADES MULTIMEDIA Y VISOR
// ==========================================
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getClientFileType(extOrName) {
  const ext = (extOrName.includes('.') ? extOrName.split('.').pop() : extOrName).toLowerCase();
  const extWithDot = `.${ext}`;
  const mediaMap = {
    image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico'],
    video: ['.mp4', '.webm', '.ogv', '.mov', '.mkv'],
    audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.weba', '.opus'],
    pdf: ['.pdf'],
    note: ['.md', '.txt']
  };
  for (const [type, exts] of Object.entries(mediaMap)) {
    if (exts.includes(extWithDot)) return type;
  }
  return 'other';
}

function getIconForFileType(type) {
  switch (type) {
    case 'image':
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    case 'video':
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
    case 'audio':
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    case 'pdf':
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`;
    case 'note':
    default:
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
  }
}

function renderMediaViewer(media) {
  if (!mediaViewerContentEl) return;
  mediaViewerContentEl.innerHTML = '';

  const { filename, name, title, type, ext, size, url } = media;
  const displayName = name || title || filename;
  const embedCode = `![[${displayName}]]`;

  let mediaHtml = '';
  if (type === 'image') {
    mediaHtml = `
      <div class="media-preview-container image-mode">
        <div class="media-canvas-wrap">
          <img id="viewer-active-image" src="${url}" alt="${displayName}" class="viewer-img" />
        </div>
        <div class="media-toolbar">
          <button id="btn-zoom-in" class="media-tool-btn" title="Acercar">+</button>
          <button id="btn-zoom-reset" class="media-tool-btn" title="Restablecer tamaño">100%</button>
          <button id="btn-zoom-out" class="media-tool-btn" title="Alejar">-</button>
        </div>
      </div>
    `;
  } else if (type === 'video') {
    mediaHtml = `
      <div class="media-preview-container video-mode">
        <video controls autoplay class="viewer-video" src="${url}">
          Tu navegador no soporta el formato de video.
        </video>
      </div>
    `;
  } else if (type === 'audio') {
    mediaHtml = `
      <div class="media-preview-container audio-mode">
        <div class="audio-card">
          <div class="audio-wave-visual">
            <span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span>
          </div>
          <div class="audio-title">${displayName}</div>
          <audio controls autoplay class="viewer-audio" src="${url}">
            Tu navegador no soporta el formato de audio.
          </audio>
        </div>
      </div>
    `;
  } else if (type === 'pdf') {
    mediaHtml = `
      <div class="media-preview-container pdf-mode">
        <iframe src="${url}" class="viewer-pdf" title="${displayName}"></iframe>
      </div>
    `;
  } else {
    mediaHtml = `
      <div class="media-preview-container generic-mode">
        <div class="generic-file-icon" style="font-size: 40px; margin-bottom: 12px;">📄</div>
        <div class="generic-file-name" style="font-size: 16px; font-weight: 700; color: var(--text-primary); margin-bottom: 16px;">${displayName}</div>
        <a href="${url}" download class="modal-btn primary" style="text-decoration: none; display: inline-flex; align-items: center; gap: 6px;">Descargar Archivo</a>
      </div>
    `;
  }

  const metaHtml = `
    <div class="media-info-bar">
      <div class="media-meta-tags">
        <span class="meta-tag type">${type.toUpperCase()}</span>
        <span class="meta-tag ext">${ext || ''}</span>
        <span class="meta-tag size">${formatFileSize(size)}</span>
      </div>
      <div class="media-meta-actions">
        <button id="btn-copy-embed" class="media-action-btn" title="Copiar código de incrustación">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>Copiar ![[${displayName}]]</span>
        </button>
        <a href="${url}" target="_blank" download class="media-action-btn" title="Descargar o abrir en pestaña nueva">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          <span>Abrir</span>
        </a>
      </div>
    </div>
  `;

  mediaViewerContentEl.innerHTML = metaHtml + mediaHtml;

  // Zoom interactivo para imágenes
  if (type === 'image') {
    let zoomLevel = 1;
    const imgEl = document.getElementById('viewer-active-image');
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
      zoomLevel = Math.min(zoomLevel + 0.25, 3);
      if (imgEl) imgEl.style.transform = `scale(${zoomLevel})`;
    });
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
      zoomLevel = Math.max(zoomLevel - 0.25, 0.25);
      if (imgEl) imgEl.style.transform = `scale(${zoomLevel})`;
    });
    document.getElementById('btn-zoom-reset')?.addEventListener('click', () => {
      zoomLevel = 1;
      if (imgEl) imgEl.style.transform = 'scale(1)';
    });
  }

  // Copiar código de incrustación
  document.getElementById('btn-copy-embed')?.addEventListener('click', () => {
    navigator.clipboard.writeText(embedCode);
    showToast(`Incrustación copiada: ${embedCode}`, 'success');
  });
}

// Carga de archivos multimedia a la bóveda
async function uploadFilesToVault(files, targetFolder) {
  if (!files || files.length === 0) return;
  const folder = targetFolder !== undefined ? targetFolder : (state.selectedFolder || (state.activeNote ? state.activeNote.folder : ''));

  let uploadedCount = 0;
  for (const file of files) {
    try {
      showToast(`Subiendo ${file.name}...`, 'info', 2000);
      const base64 = await fileToBase64(file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          folder,
          base64
        })
      });

      if (!res.ok) throw new Error('Error en el servidor al subir archivo');
      const data = await res.json();
      uploadedCount++;
    } catch (err) {
      showToast(`Error al subir ${file.name}`, 'danger');
    }
  }

  if (uploadedCount > 0) {
    showToast(`${uploadedCount} archivo(s) guardado(s) en la bóveda`, 'success');
    await loadNotesAndFolders();
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64String = reader.result.split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Mover nota actual a otra carpeta
async function moveCurrentNoteFolder() {
  if (!state.activeNote) return;

  const newFolder = await showPromptModal({
    title: 'Mover pensamiento a carpeta',
    message: `Indica la subcarpeta de destino para "${state.activeNote.title}" (deja en blanco para mover a la Raíz):`,
    placeholder: 'ej. Proyectos o Personal/Ideas',
    defaultValue: state.activeNote.folder || '',
    confirmText: 'Mover Nota'
  });

  if (newFolder === null) return;

  const cleanNewFolder = newFolder.trim().replace(/\\/g, '/');

  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: state.activeNote.title,
        folder: cleanNewFolder,
        oldPath: state.activeNote.filename,
        content: markdownInputEl.value
      })
    });

    const saved = await res.json();
    state.activeNote = saved;
    noteFolderName.textContent = saved.folder || 'Raíz';
    if (saved && saved.filename) {
      saveLastActiveNote(saved.filename);
    }

    if (cleanNewFolder) {
      state.openFolders.add(cleanNewFolder);
      saveOpenFolders();
    }

    showToast(`Nota movida a "${cleanNewFolder || 'Raíz'}"`, 'success');
    await loadNotesAndFolders();
  } catch (err) {
    showToast('Error al mover la nota', 'danger');
  }
}

// Eliminar carpeta
async function deleteFolder(folderPath) {
  const confirmed = await showConfirmModal({
    title: 'Eliminar Carpeta',
    message: `¿Estás seguro de que deseas eliminar la carpeta "${folderPath}" y todas las notas que contiene? Esta acción no se puede deshacer.`,
    confirmText: 'Eliminar Carpeta',
    cancelText: 'Cancelar',
    danger: true,
    icon: 'trash'
  });

  if (!confirmed) return;

  try {
    await fetch(`/api/folders?folder=${encodeURIComponent(folderPath)}`, {
      method: 'DELETE'
    });

    state.openFolders.delete(folderPath);
    if (state.selectedFolder === folderPath) state.selectedFolder = '';
    saveOpenFolders();

    showToast(`Carpeta "${folderPath}" eliminada`, 'danger');
    await loadNotesAndFolders();

    // Si la nota activa estaba dentro de la carpeta eliminada, limpiar o cambiar
    if (state.activeNote && (state.activeNote.folder === folderPath || state.activeNote.folder.startsWith(folderPath + '/'))) {
      clearLastActiveNote();
      if (state.notes.length > 0) {
        restoreOrSelectDefaultNote();
      } else {
        state.activeNote = null;
        titleInputEl.value = '';
        markdownInputEl.value = '';
        markdownPreviewEl.innerHTML = '';
      }
    }
  } catch (err) {
    showToast('Error al eliminar la carpeta', 'danger');
  }
}

async function loadBacklinks(title) {
  try {
    const res = await fetch(`/api/backlinks/${encodeURIComponent(title)}`);
    const backlinks = await res.json();
    renderBacklinks(backlinks);
  } catch (err) {
    console.error('Error cargando backlinks:', err);
  }
}

// ==========================================
// 4. PARSEO, INCRUSTACIONES MULTIMEDIA Y WIKILINKS [[...]]
// ==========================================
function renderMarkdown() {
  const rawText = markdownInputEl.value;

  // 1. Incrustaciones tipo Obsidian: ![[archivo.ext]] o ![[archivo.ext|300]]
  let processedText = rawText.replace(/!\[\[(.*?)\]\]/g, (match, rawInner) => {
    let target = rawInner.trim();
    let widthStyle = '';
    if (target.includes('|')) {
      const parts = target.split('|');
      target = parts[0].trim();
      const param = parts[1].trim();
      if (/^\d+$/.test(param)) {
        widthStyle = `width: ${param}px; max-width: 100%;`;
      }
    }

    const cleanTarget = target.toLowerCase();
    const found = state.notes.find(n => 
      n.name?.toLowerCase() === cleanTarget || 
      n.filename?.toLowerCase() === cleanTarget || 
      n.title?.toLowerCase() === cleanTarget ||
      n.name?.toLowerCase() === `${cleanTarget}.md`
    );

    const fileUrl = found ? `/api/vault-raw/${encodeURI(found.filename)}` : `/api/vault-raw/${encodeURI(target)}`;
    const fileType = found ? found.type : getClientFileType(target);

    if (fileType === 'image') {
      return `<div class="embedded-media-block"><img src="${fileUrl}" alt="${target}" style="${widthStyle}" class="embedded-media-img" loading="lazy" /></div>`;
    } else if (fileType === 'video') {
      return `<div class="embedded-media-block"><video controls src="${fileUrl}" style="${widthStyle}" class="embedded-media-video"></video></div>`;
    } else if (fileType === 'audio') {
      return `<div class="embedded-media-block embedded-audio-block"><audio controls src="${fileUrl}" class="embedded-media-audio"></audio><span class="embedded-caption">🎧 ${target}</span></div>`;
    } else if (fileType === 'pdf') {
      return `<div class="embedded-media-block embedded-pdf-block"><iframe src="${fileUrl}" class="embedded-media-pdf"></iframe><a href="${fileUrl}" target="_blank" class="pdf-link-out">Abrir ${target} ↗</a></div>`;
    }

    if (found && found.type === 'note') {
      return `<div class="embedded-note-card"><a class="wikilink" href="#" data-target="${found.title}">[[${found.title}]]</a></div>`;
    }

    return `<a class="wikilink missing" href="#" data-target="${target}">![[${target}]]</a>`;
  });

  // 2. Enlaces wikilink estándar [[Nombre]]
  processedText = processedText.replace(/\[\[(.*?)\]\]/g, (match, noteName) => {
    const cleanName = noteName.trim();
    const found = state.notes.find(n => 
      n.title.toLowerCase() === cleanName.toLowerCase() || 
      n.name?.toLowerCase() === cleanName.toLowerCase() ||
      n.filename.toLowerCase() === cleanName.toLowerCase()
    );
    const exists = !!found;
    const extraClass = exists ? '' : 'missing';
    const titleAttr = exists ? `Abrir: ${cleanName}` : `Crear nota "${cleanName}"`;
    return `<a class="wikilink ${extraClass}" href="#" data-target="${cleanName}" title="${titleAttr}">[[${cleanName}]]</a>`;
  });

  // 3. Soporte de resaltado ==texto== (estilo Obsidian)
  processedText = processedText.replace(/==([^=\n]+)==/g, '<mark class="md-highlight">$1</mark>');

  // Renderizar Markdown a HTML con Marked
  markdownPreviewEl.innerHTML = marked.parse(processedText);

  // Remapear imágenes estándar de markdown ![alt](ruta-relativa)
  markdownPreviewEl.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src');
    if (src && !src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:') && !src.startsWith('/api/')) {
      const cleanSrc = src.replace(/^\.\//, '');
      const found = state.notes.find(n => 
        n.filename.toLowerCase() === cleanSrc.toLowerCase() || 
        n.name?.toLowerCase() === cleanSrc.toLowerCase()
      );
      img.src = found ? `/api/vault-raw/${encodeURI(found.filename)}` : `/api/vault-raw/${encodeURI(cleanSrc)}`;
      img.classList.add('markdown-img-vault');
    }
  });

  // Asignar clics a los enlaces [[wikilinks]]
  markdownPreviewEl.querySelectorAll('.wikilink').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetNote = link.getAttribute('data-target');
      selectNote(targetNote);
    });
  });

  // 4. Procesar e incrustar Hojas de Cálculo FortuneSheet (Excel interactivo)
  processFortuneSheetsInPreview();
}

// ==========================================
// 5. RENDERIZADO DEL ÁRBOL JERÁRQUICO
// ==========================================
function buildTreeStructure(notes, folders) {
  const root = {
    name: '',
    fullPath: '',
    subfolders: {},
    notes: []
  };

  // 1. Registrar todas las carpetas (incluso las vacías)
  folders.forEach(fPath => {
    const parts = fPath.split('/');
    let current = root;
    let accumulated = '';

    parts.forEach(part => {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      if (!current.subfolders[part]) {
        current.subfolders[part] = {
          name: part,
          fullPath: accumulated,
          subfolders: {},
          notes: []
        };
      }
      current = current.subfolders[part];
    });
  });

  // 2. Colocar cada nota en su carpeta correspondiente
  notes.forEach(note => {
    if (!note.folder) {
      root.notes.push(note);
    } else {
      const parts = note.folder.split('/');
      let current = root;
      let accumulated = '';

      parts.forEach(part => {
        accumulated = accumulated ? `${accumulated}/${part}` : part;
        if (!current.subfolders[part]) {
          current.subfolders[part] = {
            name: part,
            fullPath: accumulated,
            subfolders: {},
            notes: []
          };
        }
        current = current.subfolders[part];
      });

      current.notes.push(note);
    }
  });

  return root;
}

function countTotalNotesInFolder(folderNode) {
  let count = folderNode.notes.length;
  Object.values(folderNode.subfolders).forEach(sub => {
    count += countTotalNotesInFolder(sub);
  });
  return count;
}

function renderTree(notesToRender, folders) {
  notesListEl.innerHTML = '';
  notesCountEl.textContent = notesToRender.length;

  const treeRoot = buildTreeStructure(notesToRender, folders);

  // Renderizar carpetas recursivamente
  function renderFolderNode(node, container) {
    const sortedSubKeys = Object.keys(node.subfolders).sort();

    sortedSubKeys.forEach(key => {
      const subNode = node.subfolders[key];
      const folderTotal = countTotalNotesInFolder(subNode);

      const folderGroup = document.createElement('div');
      folderGroup.className = 'folder-group';
      const isOpen = state.openFolders.has(subNode.fullPath);
      if (isOpen) folderGroup.classList.add('open');

      const header = document.createElement('div');
      header.className = 'folder-header';
      if (state.selectedFolder === subNode.fullPath) {
        header.classList.add('active-folder');
      }

      header.innerHTML = `
        <div class="folder-title-wrap">
          <svg class="folder-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span class="folder-name" title="${subNode.fullPath}">${subNode.name}</span>
        </div>
        <div class="folder-meta">
          <span class="folder-badge">${folderTotal}</span>
          <button class="folder-add-btn" title="Añadir nota o subcarpeta en ${subNode.name}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <button class="folder-delete-btn" title="Eliminar carpeta ${subNode.name}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      `;

      // Clic para expandir/colapsar o seleccionar carpeta
      header.addEventListener('click', (e) => {
        const addBtn = e.target.closest('.folder-add-btn');
        if (addBtn) {
          e.stopPropagation();
          showFolderActionMenu(addBtn, subNode.fullPath, subNode.name);
          return;
        }

        if (e.target.closest('.folder-delete-btn')) {
          e.stopPropagation();
          deleteFolder(subNode.fullPath);
          return;
        }

        const currentlyOpen = state.openFolders.has(subNode.fullPath);
        if (currentlyOpen) {
          state.openFolders.delete(subNode.fullPath);
          folderGroup.classList.remove('open');
        } else {
          state.openFolders.add(subNode.fullPath);
          folderGroup.classList.add('open');
        }
        state.selectedFolder = subNode.fullPath;
        saveOpenFolders();
        
        // Actualizar clase activa en todos los headers
        document.querySelectorAll('.folder-header').forEach(h => h.classList.remove('active-folder'));
        header.classList.add('active-folder');
      });

      const childrenContainer = document.createElement('div');
      childrenContainer.className = 'folder-children';

      // Renderizar subcarpetas hijas
      renderFolderNode(subNode, childrenContainer);

      // Renderizar notas dentro de esta carpeta
      subNode.notes.forEach(note => {
        const noteEl = createNoteListItem(note);
        childrenContainer.appendChild(noteEl);
      });

      folderGroup.appendChild(header);
      folderGroup.appendChild(childrenContainer);
      container.appendChild(folderGroup);
    });
  }

  // Renderizar carpetas principales
  renderFolderNode(treeRoot, notesListEl);

  // Renderizar notas raíz (que no pertenecen a ninguna subcarpeta)
  if (treeRoot.notes.length > 0) {
    treeRoot.notes.forEach(note => {
      const noteEl = createNoteListItem(note);
      notesListEl.appendChild(noteEl);
    });
  }
}

function createNoteListItem(note) {
  const li = document.createElement('li');
  const fileType = note.type || 'note';
  li.className = `note-item type-${fileType}`;
  if (state.activeNote && (state.activeNote.filename === note.filename || state.activeNote.title === note.title || state.activeNote.name === note.name)) {
    li.classList.add('active');
  }

  const iconSpan = document.createElement('span');
  iconSpan.className = 'note-item-icon';
  iconSpan.innerHTML = getIconForFileType(fileType);

  const titleSpan = document.createElement('span');
  titleSpan.className = 'note-title';
  titleSpan.textContent = note.name || note.title;
  titleSpan.title = note.folder ? `${note.folder}/${note.name || note.title}` : (note.name || note.title);

  li.appendChild(iconSpan);
  li.appendChild(titleSpan);

  li.addEventListener('click', (e) => {
    e.stopPropagation();
    selectNote(note.filename);
  });

  return li;
}

function renderBacklinks(backlinks) {
  backlinksCountEl.textContent = backlinks.length;
  backlinksListEl.innerHTML = '';

  if (backlinks.length === 0) {
    backlinksListEl.innerHTML = '<span class="no-backlinks">No hay conexiones entrantes hacia este pensamiento.</span>';
    return;
  }

  backlinks.forEach(item => {
    const chip = document.createElement('span');
    chip.className = 'backlink-chip';
    chip.textContent = item.title;
    if (item.folder) chip.title = `Carpeta: ${item.folder}`;
    chip.addEventListener('click', () => {
      selectNote(item.filename || item.title);
    });
    backlinksListEl.appendChild(chip);
  });
}

function setSaveStatus(text, isSaving = false) {
  saveStatusEl.textContent = text;
  if (saveStatusContainerEl) {
    saveStatusContainerEl.className = isSaving ? 'status-pill saving' : 'status-pill';
  }
}

function scheduleSave(shouldRenderMarkdown = true) {
  setSaveStatus('Modificado...');
  if (shouldRenderMarkdown) {
    renderMarkdown();
  }
  clearTimeout(state.saveTimeout);
  state.saveTimeout = setTimeout(saveCurrentNote, 600);
}

// ==========================================
// 6. GESTIÓN DE TEMAS (CLARO / OSCURO / AUTO)
// ==========================================
function getResolvedTheme() {
  if (state.theme === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return state.theme;
}

function applyTheme(mode) {
  state.theme = mode;
  localStorage.setItem('kortexa-theme', mode);

  const resolved = getResolvedTheme();
  document.documentElement.setAttribute('data-resolved-theme', resolved);
  document.documentElement.setAttribute('data-theme-mode', mode);

  [themeBtnLight, themeBtnDark, themeBtnAuto].forEach(btn => {
    if (!btn) return;
    if (btn.getAttribute('data-theme-val') === mode) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  if (state.activeTab === 'graph' && state.graphInstance) {
    renderGraph();
  }
}

// ==========================================
// 7. VISTA DE GRAFO INTERACTIVO
// ==========================================
async function renderGraph() {
  try {
    const res = await fetch('/api/graph');
    const graphData = await res.json();
    const container = document.getElementById('graph-container');
    container.innerHTML = '';

    const width = container.clientWidth || (window.innerWidth <= 768 ? window.innerWidth : window.innerWidth - 300);
    const height = container.clientHeight || window.innerHeight;

    const isDark = getResolvedTheme() === 'dark';
    const bgColor = isDark ? '#070a13' : '#f8fafc';
    const activeColor = isDark ? '#00f2fe' : '#0284c7';
    const existColor = isDark ? '#818cf8' : '#4f46e5';
    const missingColor = isDark ? '#f43f5e' : '#e11d48';
    const linkColor = isDark ? 'rgba(129, 140, 248, 0.25)' : 'rgba(79, 70, 229, 0.2)';
    const particleColor = isDark ? '#00f2fe' : '#0284c7';

    state.graphInstance = ForceGraph()(container)
      .width(width)
      .height(height)
      .backgroundColor(bgColor)
      .graphData(graphData)
      .nodeId('id')
      .nodeLabel(node => node.folder ? `${node.name} (📁 ${node.folder})` : node.name)
      .nodeColor(node => {
        if (state.activeNote && node.id === state.activeNote.title) return activeColor;
        return node.exists ? existColor : missingColor;
      })
      .nodeRelSize(7)
      .linkColor(() => linkColor)
      .linkDirectionalParticles(3)
      .linkDirectionalParticleSpeed(0.007)
      .linkDirectionalParticleColor(() => particleColor)
      .linkDirectionalParticleWidth(2)
      .onNodeClick(node => {
        selectNote(node.filename || node.id);
      });
  } catch (err) {
    console.error('Error inicializando grafo:', err);
  }
}

// ==========================================
// 8. CONTROLES MÓVILES (DRAWER LATERAL)
// ==========================================
function openMobileSidebar() {
  appSidebarEl?.classList.add('mobile-open');
  sidebarBackdropEl?.classList.add('active');
}

function closeMobileSidebar() {
  appSidebarEl?.classList.remove('mobile-open');
  sidebarBackdropEl?.classList.remove('active');
}

// ==========================================
// 9. EVENTOS Y CAMBIO DE VISTAS
// ==========================================
function switchTab(tabName) {
  closeMobileSidebar();
  state.activeTab = tabName;
  if (tabName === 'editor') {
    navEditorBtn.classList.add('active');
    navGraphBtn.classList.remove('active');
    viewEditor.classList.add('active');
    viewGraph.classList.remove('active');
  } else {
    navGraphBtn.classList.add('active');
    navEditorBtn.classList.remove('active');
    viewGraph.classList.add('active');
    viewEditor.classList.remove('active');
    renderGraph();
  }
}

function setupEventListeners() {
  // Controles de apertura y cierre de sidebar móvil
  btnToggleSidebarEl?.addEventListener('click', openMobileSidebar);
  btnGraphMenuEl?.addEventListener('click', openMobileSidebar);
  btnCloseSidebarEl?.addEventListener('click', closeMobileSidebar);
  sidebarBackdropEl?.addEventListener('click', closeMobileSidebar);

  // Input de búsqueda (expande carpetas que tengan coincidencias)
  searchInputEl.addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase().trim();
    if (!term) {
      renderTree(state.notes, state.folders);
      return;
    }

    const filtered = state.notes.filter(n => 
      n.title.toLowerCase().includes(term) || (n.folder && n.folder.toLowerCase().includes(term))
    );

    // Expandir carpetas de las notas coincidentes
    filtered.forEach(note => {
      if (note.folder) {
        let acc = '';
        note.folder.split('/').forEach(p => {
          acc = acc ? `${acc}/${p}` : p;
          state.openFolders.add(acc);
        });
      }
    });

    renderTree(filtered, state.folders);
  });

  // Limpiar búsqueda con tecla Escape
  searchInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInputEl.value) {
      e.stopPropagation();
      searchInputEl.value = '';
      renderTree(state.notes, state.folders);
      searchInputEl.blur();
    }
  });

  // Editor y autosave
  markdownInputEl.addEventListener('input', scheduleSave);
  titleInputEl.addEventListener('input', scheduleSave);

  // Mover nota actual al hacer clic en el badge de carpeta
  noteFolderBadge?.addEventListener('click', moveCurrentNoteFolder);

  // Atajos de teclado:
  // 1. Guardar manual: Ctrl+S / Cmd+S
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrentNote();
    }
  });

  // 2. Buscador Spotlight: Ctrl+K / Cmd+K
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      // Si el drawer está cerrado en móvil, abrirlo para mostrar la búsqueda
      if (window.innerWidth <= 768 && appSidebarEl && !appSidebarEl.classList.contains('open')) {
        appSidebarEl.classList.add('open');
        sidebarBackdropEl?.classList.add('active');
      }
      searchInputEl?.focus();
      searchInputEl?.select();
    }
  });

  // 3. Bloquear Bóveda: Ctrl+L / Cmd+L
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      lockActiveVault();
    }
  });

  // Botón nueva nota
  btnNewNote.addEventListener('click', () => {
    const targetFolder = state.selectedFolder || (state.activeNote ? state.activeNote.folder : '');
    createNewNoteInFolder(targetFolder);
  });

  // Cerrar menú contextual de carpeta al hacer clic fuera, scroll o Escape
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.folder-action-menu') && !e.target.closest('.folder-add-btn')) {
      closeFolderMenu();
    }
  });
  window.addEventListener('resize', closeFolderMenu);
  window.addEventListener('scroll', closeFolderMenu, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeFolderMenu();
      closeVaultManagerModal();
      closeVaultDropdown();
      closeVaultMoreMenu();
    }
  });

  // Botón nueva carpeta
  btnNewFolder?.addEventListener('click', () => createNewFolder());

  // Botón colapsar todo el árbol
  btnCollapseAll?.addEventListener('click', collapseAllFolders);

  // Renombrar bóveda
  btnRenameVault?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeVaultMoreMenu();
    renameVault();
  });

  // Crear nueva bóveda
  btnAddVault?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeVaultMoreMenu();
    createNewVault();
  });
  btnVaultManagerNew?.addEventListener('click', () => {
    createNewVault();
  });

  // Eliminar bóveda activa
  btnDeleteVault?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeVaultMoreMenu();
    deleteVault(state.activeVault || 'vault');
  });

  // Dropdown interactivo para cambiar de bóveda (Cabecera Notion)
  vaultDropdownTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleVaultDropdown();
  });

  // Menú emergente de más opciones de bóveda (Puntos suspensivos - Cabecera Notion)
  btnVaultMore?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleVaultMoreMenu();
  });

  btnManageVault?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeVaultMoreMenu();
    openVaultManagerModal();
  });

  document.addEventListener('click', (e) => {
    if (customVaultDropdown && !customVaultDropdown.contains(e.target)) {
      closeVaultDropdown();
    }
    if (vaultMoreDropdown && !vaultMoreDropdown.contains(e.target)) {
      closeVaultMoreMenu();
    }
  });

  // Gestor y selector de bóvedas
  treeVaultName?.addEventListener('click', (e) => {
    e.stopPropagation();
    openVaultManagerModal();
  });
  vaultStatusIndicator?.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    openVaultManagerModal();
  });
  btnCloseVaultManager?.addEventListener('click', closeVaultManagerModal);
  vaultManagerModal?.addEventListener('click', (e) => {
    if (e.target === vaultManagerModal) closeVaultManagerModal();
  });

  // Botones de seguridad / bloqueo de bóveda
  btnLockVault?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeVaultMoreMenu();
    if (state.isVaultEncrypted && !state.isVaultLocked) {
      lockActiveVault();
    } else {
      manageVaultSecurity();
    }
  });
  btnVaultManagerSecurity?.addEventListener('click', () => {
    manageVaultSecurity();
  });

  // Pantalla de bloqueo
  formUnlockVault?.addEventListener('submit', (e) => {
    e.preventDefault();
    const pwd = inputVaultPassword?.value || '';
    if (pwd) {
      unlockActiveVault(pwd);
    }
  });

  btnToggleLockPwd?.addEventListener('click', () => {
    if (!inputVaultPassword) return;
    const isPwd = inputVaultPassword.type === 'password';
    inputVaultPassword.type = isPwd ? 'text' : 'password';
  });

  btnLockSwitchOther?.addEventListener('click', () => {
    openVaultManagerModal();
  });

  // Botón eliminar nota
  btnDeleteNote.addEventListener('click', deleteCurrentNote);

  // Navegación de pestañas
  navEditorBtn.addEventListener('click', () => switchTab('editor'));
  navGraphBtn.addEventListener('click', () => switchTab('graph'));

  // Modos de visualización del editor
  btnModeSplit.addEventListener('click', () => {
    editorWorkspaceEl.className = 'editor-body split-mode';
    if (markdownToolbarEl) markdownToolbarEl.style.display = 'flex';
    setActiveModeBtn(btnModeSplit);
  });

  btnModePreview.addEventListener('click', () => {
    editorWorkspaceEl.className = 'editor-body preview-mode';
    if (markdownToolbarEl) markdownToolbarEl.style.display = 'none';
    setActiveModeBtn(btnModePreview);
  });

  btnModeEdit.addEventListener('click', () => {
    editorWorkspaceEl.className = 'editor-body edit-mode';
    if (markdownToolbarEl) markdownToolbarEl.style.display = 'flex';
    setActiveModeBtn(btnModeEdit);
  });

  // Inicializar barra de herramientas de formato Markdown, selector de imágenes y selector de videos
  setupMarkdownToolbar();
  setupImagePickerEventListeners();
  setupVideoPickerEventListeners();
  setupAudioPickerEventListeners();
  setupVoiceRecorderEventListeners();
  setupFortuneSheetEventListeners();

  // Selector de tema (Claro, Oscuro, Automático)
  themeBtnLight?.addEventListener('click', () => applyTheme('light'));
  themeBtnDark?.addEventListener('click', () => applyTheme('dark'));
  themeBtnAuto?.addEventListener('click', () => applyTheme('auto'));

  // Detectar cambios dinámicos del sistema operativo si está en modo 'auto'
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'auto') {
      applyTheme('auto');
    }
  });

  // Selector de archivos multimedia oculto
  mediaFileInput?.addEventListener('change', async (e) => {
    const files = e.target.files;
    const targetFolder = mediaFileInput.dataset.targetFolder || '';
    if (files && files.length > 0) {
      await uploadFilesToVault(files, targetFolder);
      mediaFileInput.value = '';
    }
  });

  // Soporte Drag & Drop de archivos hacia la bóveda
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('drag-active');
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
      document.body.classList.remove('drag-active');
    }
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    document.body.classList.remove('drag-active');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const targetFolder = state.selectedFolder || (state.activeNote ? state.activeNote.folder : '');
    await uploadFilesToVault(files, targetFolder);

    // Si se soltó sobre el editor textarea, insertar ![[archivo.ext]] automáticamente
    if (e.target === markdownInputEl && state.activeNote && state.activeNote.type === 'note') {
      const insertText = Array.from(files).map(f => `![[${f.name}]]`).join('\n');
      const startPos = markdownInputEl.selectionStart || markdownInputEl.value.length;
      const val = markdownInputEl.value;
      markdownInputEl.value = val.substring(0, startPos) + '\n' + insertText + '\n' + val.substring(startPos);
      scheduleSave();
      renderMarkdown();
    }
  });

  // Redimensionar grafo si la ventana cambia de tamaño
  window.addEventListener('resize', () => {
    if (state.activeTab === 'graph' && state.graphInstance) {
      renderGraph();
    }
  });
}

// ==========================================
// 10. BARRA DE HERRAMIENTAS DE FORMATO (ESTILO WORD)
// ==========================================
function applyMarkdownFormat(action, extraValue) {
  const textarea = markdownInputEl;
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const fullText = textarea.value;
  const selectedText = fullText.substring(start, end);

  let replacement = '';
  let newCursorStart = start;
  let newCursorEnd = end;

  switch (action) {
    case 'heading': {
      const lineStart = fullText.lastIndexOf('\n', start - 1) + 1;
      let lineEnd = fullText.indexOf('\n', end);
      if (lineEnd === -1) lineEnd = fullText.length;
      const currentLine = fullText.substring(lineStart, lineEnd);

      const cleanedLine = currentLine.replace(/^#{1,6}\s+/, '');
      let prefix = '';
      if (extraValue === 'h1') prefix = '# ';
      else if (extraValue === 'h2') prefix = '## ';
      else if (extraValue === 'h3') prefix = '### ';
      else if (extraValue === 'h4') prefix = '#### ';
      else if (extraValue === 'h5') prefix = '##### ';
      else if (extraValue === 'h6') prefix = '###### ';

      const newLine = prefix + cleanedLine;
      textarea.value = fullText.substring(0, lineStart) + newLine + fullText.substring(lineEnd);
      newCursorStart = lineStart + prefix.length;
      newCursorEnd = lineStart + newLine.length;
      break;
    }

    case 'size': {
      if (extraValue === 'huge') {
        return applyMarkdownFormat('heading', 'h1');
      } else if (extraValue === 'large') {
        return applyMarkdownFormat('heading', 'h2');
      } else if (extraValue === 'medium') {
        return applyMarkdownFormat('heading', 'h3');
      } else if (extraValue === 'small') {
        const text = selectedText || 'texto pequeño';
        replacement = `<small>${text}</small>`;
        textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
        newCursorStart = start + 7;
        newCursorEnd = newCursorStart + text.length;
      } else {
        return applyMarkdownFormat('heading', 'p');
      }
      break;
    }

    case 'bold': {
      const text = selectedText || 'texto en negrita';
      replacement = `**${text}**`;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + 2;
      newCursorEnd = newCursorStart + text.length;
      break;
    }

    case 'italic': {
      const text = selectedText || 'texto en cursiva';
      replacement = `*${text}*`;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + 1;
      newCursorEnd = newCursorStart + text.length;
      break;
    }

    case 'underline': {
      const text = selectedText || 'texto subrayado';
      replacement = `<u>${text}</u>`;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + 3;
      newCursorEnd = newCursorStart + text.length;
      break;
    }

    case 'strike': {
      const text = selectedText || 'texto tachado';
      replacement = `~~${text}~~`;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + 2;
      newCursorEnd = newCursorStart + text.length;
      break;
    }

    case 'highlight': {
      const text = selectedText || 'texto resaltado';
      replacement = `==${text}==`;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + 2;
      newCursorEnd = newCursorStart + text.length;
      break;
    }

    case 'bullet-list': {
      const text = selectedText || 'Elemento de lista';
      const lines = text.split('\n');
      const formatted = lines.map(line => line.startsWith('- ') ? line : `- ${line}`).join('\n');
      replacement = formatted;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start;
      newCursorEnd = start + replacement.length;
      break;
    }

    case 'ordered-list': {
      const text = selectedText || 'Elemento numerado';
      const lines = text.split('\n');
      const formatted = lines.map((line, idx) => {
        const clean = line.replace(/^\d+\.\s+/, '');
        return `${idx + 1}. ${clean}`;
      }).join('\n');
      replacement = formatted;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start;
      newCursorEnd = start + replacement.length;
      break;
    }

    case 'task-list': {
      const text = selectedText || 'Nueva tarea';
      const lines = text.split('\n');
      const formatted = lines.map(line => line.startsWith('- [ ] ') || line.startsWith('- [x] ') ? line : `- [ ] ${line}`).join('\n');
      replacement = formatted;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start;
      newCursorEnd = start + replacement.length;
      break;
    }

    case 'quote': {
      const text = selectedText || 'Cita de texto...';
      const lines = text.split('\n');
      const formatted = lines.map(line => line.startsWith('> ') ? line : `> ${line}`).join('\n');
      replacement = formatted;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start;
      newCursorEnd = start + replacement.length;
      break;
    }

    case 'code': {
      const text = selectedText || 'código';
      replacement = `\`${text}\``;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + 1;
      newCursorEnd = newCursorStart + text.length;
      break;
    }

    case 'codeblock': {
      const text = selectedText || '// Escribe tu código aquí';
      replacement = `\n\`\`\`javascript\n${text}\n\`\`\`\n`;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + 15;
      newCursorEnd = newCursorStart + text.length;
      break;
    }

    case 'table': {
      replacement = `\n| Columna 1 | Columna 2 | Columna 3 |\n| :--- | :---: | ---: |\n| Dato A | Dato B | Dato C |\n| Dato D | Dato E | Dato F |\n\n`;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + 3;
      newCursorEnd = start + 12;
      break;
    }

    case 'sheet': {
      replacement = `\n\`\`\`sheet\n[\n  ["Concepto", "Cantidad", "Precio Unitario", "Total"],\n  ["Servidor Cloud", 2, 45, "=B2*C2"],\n  ["Dominio Web", 1, 15, "=B3*C3"],\n  ["Total Inversión", "", "", "=SUM(D2:D3)"]\n]\n\`\`\`\n`;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + replacement.length;
      newCursorEnd = newCursorStart;
      break;
    }

    case 'hr': {
      replacement = `\n---\n\n`;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + replacement.length;
      newCursorEnd = newCursorStart;
      break;
    }

    case 'link': {
      const text = selectedText || 'Texto del enlace';
      replacement = `[${text}](https://ejemplo.com)`;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + text.length + 3;
      newCursorEnd = newCursorStart + 19;
      break;
    }

    case 'wikilink': {
      const text = selectedText || 'Nota Conectada';
      replacement = `[[${text}]]`;
      textarea.value = fullText.substring(0, start) + replacement + fullText.substring(end);
      newCursorStart = start + 2;
      newCursorEnd = newCursorStart + text.length;
      break;
    }

    case 'image': {
      openImagePickerModal();
      return;
    }

    case 'video': {
      openVideoPickerModal();
      return;
    }

    case 'audio': {
      openAudioPickerModal();
      return;
    }

    case 'record-audio': {
      openVoiceRecorderModal();
      return;
    }
  }

  // Restaurar foco y selección
  textarea.focus();
  textarea.setSelectionRange(newCursorStart, newCursorEnd);

  // Sincronizar previsualización en vivo y activar auto-guardado
  renderMarkdown();
  scheduleSave();
}

function setupMarkdownToolbar() {
  if (!markdownToolbarEl || !markdownInputEl) return;

  // Manejador para botones de la barra de herramientas
  markdownToolbarEl.querySelectorAll('.toolbar-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const action = btn.getAttribute('data-action');
      if (action) {
        applyMarkdownFormat(action);
      }
    });
  });

  // Selector de Encabezados
  if (toolbarHeadingSelect) {
    toolbarHeadingSelect.addEventListener('change', () => {
      const val = toolbarHeadingSelect.value;
      applyMarkdownFormat('heading', val);
      toolbarHeadingSelect.value = 'p';
    });
  }

  // Selector de Tamaño
  if (toolbarSizeSelect) {
    toolbarSizeSelect.addEventListener('change', () => {
      const val = toolbarSizeSelect.value;
      applyMarkdownFormat('size', val);
      toolbarSizeSelect.value = 'normal';
    });
  }

  // Atajos de teclado en el editor Markdown
  markdownInputEl.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        applyMarkdownFormat('bold');
      } else if (key === 'i') {
        e.preventDefault();
        applyMarkdownFormat('italic');
      } else if (key === 'u') {
        e.preventDefault();
        applyMarkdownFormat('underline');
      } else if (key === 'k') {
        e.preventDefault();
        applyMarkdownFormat('link');
      } else if (key === 'm') {
        e.preventDefault();
        openVoiceRecorderModal();
      }
    }
  });
}

// ==========================================
// 11. SELECTOR DE IMÁGENES DE LA BÓVEDA
// ==========================================
function insertImageIntoEditor(imageRef, isExternal = false) {
  const textarea = markdownInputEl;
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const fullText = textarea.value;

  const tag = isExternal ? `![Imagen](${imageRef})` : `![[${imageRef}]]`;
  textarea.value = fullText.substring(0, start) + tag + fullText.substring(end);
  const newPos = start + tag.length;
  textarea.focus();
  textarea.setSelectionRange(newPos, newPos);
  renderMarkdown();
  scheduleSave();
}

function openImagePickerModal() {
  if (!imagePickerModal) return;
  selectedImageFile = null;
  if (btnConfirmImagePicker) btnConfirmImagePicker.disabled = true;
  if (imagePickerSearch) imagePickerSearch.value = '';

  renderImagePickerGrid('');
  imagePickerModal.classList.add('active');
  setTimeout(() => imagePickerSearch?.focus(), 80);
}

function closeImagePickerModal() {
  imagePickerModal?.classList.remove('active');
  selectedImageFile = null;
}

function renderImagePickerGrid(searchTerm = '') {
  if (!imagePickerGrid) return;
  const term = searchTerm.trim().toLowerCase();

  const imageFiles = (state.notes || []).filter(f => f.type === 'image');
  const filtered = imageFiles.filter(f => {
    if (!term) return true;
    const nameMatch = (f.name || f.title || '').toLowerCase().includes(term);
    const folderMatch = (f.folder || '').toLowerCase().includes(term);
    const pathMatch = (f.filename || '').toLowerCase().includes(term);
    return nameMatch || folderMatch || pathMatch;
  });

  if (filtered.length === 0) {
    if (imageFiles.length === 0) {
      imagePickerGrid.innerHTML = `
        <div class="image-picker-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          <div style="font-weight: 600; color: var(--text-primary);">No hay imágenes en esta bóveda</div>
          <div style="font-size: 11.5px;">Haz clic en "+ Subir Nueva Imagen" o arrastra fotos desde tu equipo.</div>
        </div>`;
    } else {
      imagePickerGrid.innerHTML = `
        <div class="image-picker-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <div style="font-weight: 600; color: var(--text-primary);">Sin resultados para "${escapeHtml(searchTerm)}"</div>
          <div style="font-size: 11.5px;">Intenta con otro término o limpia el buscador.</div>
        </div>`;
    }
    return;
  }

  imagePickerGrid.innerHTML = filtered.map(f => {
    const isSelected = selectedImageFile && selectedImageFile.filename === f.filename;
    const url = f.url || `/api/vault-raw/${encodeURI(f.filename)}`;
    const folderLabel = f.folder ? `📁 ${escapeHtml(f.folder)} • ` : '';
    const sizeLabel = formatFileSize(f.size);

    return `
      <div class="image-picker-item ${isSelected ? 'selected' : ''}" data-filename="${escapeHtml(f.filename)}" title="${escapeHtml(f.name || f.title)}">
        <div class="image-picker-thumb">
          <img src="${url}" alt="${escapeHtml(f.name || f.title)}" loading="lazy">
        </div>
        <div class="image-picker-info">
          <span class="image-picker-name">${escapeHtml(f.name || f.title)}</span>
          <span class="image-picker-meta">${folderLabel}${sizeLabel}</span>
        </div>
      </div>`;
  }).join('');

  // Asignar selección por clic y doble clic para inserción rápida
  imagePickerGrid.querySelectorAll('.image-picker-item').forEach(item => {
    const filename = item.getAttribute('data-filename');
    const fileObj = filtered.find(f => f.filename === filename);

    item.addEventListener('click', () => {
      imagePickerGrid.querySelectorAll('.image-picker-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedImageFile = fileObj;
      if (btnConfirmImagePicker) btnConfirmImagePicker.disabled = false;
    });

    item.addEventListener('dblclick', () => {
      selectedImageFile = fileObj;
      confirmImageInsertion();
    });
  });
}

function confirmImageInsertion() {
  if (!selectedImageFile) return;
  const imageRef = selectedImageFile.name || selectedImageFile.title || selectedImageFile.filename;
  insertImageIntoEditor(imageRef, false);
  closeImagePickerModal();
  showToast(`Imagen "${imageRef}" insertada`, 'success');
}

function setupImagePickerEventListeners() {
  // Filtro de búsqueda en vivo
  imagePickerSearch?.addEventListener('input', (e) => {
    renderImagePickerGrid(e.target.value);
  });

  // Botón confirmar inserción
  btnConfirmImagePicker?.addEventListener('click', confirmImageInsertion);

  // Botón cerrar / cancelar
  btnCloseImagePicker?.addEventListener('click', closeImagePickerModal);

  // Cerrar al hacer clic en el backdrop exterior
  imagePickerModal?.addEventListener('click', (e) => {
    if (e.target === imagePickerModal) {
      closeImagePickerModal();
    }
  });

  // Botón insertar por URL
  btnImagePickerUrl?.addEventListener('click', async () => {
    const url = await showPromptModal({
      title: 'Insertar Imagen por URL',
      message: 'Ingresa la dirección web completa de la imagen (https://...):',
      placeholder: 'https://ejemplo.com/imagen.png'
    });
    if (url && url.trim()) {
      insertImageIntoEditor(url.trim(), true);
      closeImagePickerModal();
      showToast('Imagen web insertada', 'success');
    }
  });

  // Botón subir nueva imagen
  btnImagePickerUpload?.addEventListener('click', () => {
    imagePickerFileInput?.click();
  });

  // Procesar archivo seleccionado en el input de carga
  imagePickerFileInput?.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const targetFolder = state.selectedFolder || (state.activeNote ? state.activeNote.folder : '');
      await uploadFilesToVault(files, targetFolder);
      imagePickerFileInput.value = '';

      // Seleccionar automáticamente el archivo recién subido
      const uploadedName = files[0].name;
      const found = (state.notes || []).find(f => (f.name === uploadedName || f.title === uploadedName) && f.type === 'image');
      if (found) {
        selectedImageFile = found;
        if (btnConfirmImagePicker) btnConfirmImagePicker.disabled = false;
      }
      renderImagePickerGrid(imagePickerSearch ? imagePickerSearch.value : '');
    }
  });
}

// ==========================================
// 12. SELECTOR DE VIDEOS (BÓVEDA & YOUTUBE / WEB)
// ==========================================
function extractYouTubeId(url) {
  if (!url) return null;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/i);
  return match ? match[1] : null;
}

function insertVideoIntoEditor(videoMarkupOrRef, isCustomMarkup = false) {
  const textarea = markdownInputEl;
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const fullText = textarea.value;

  const insertText = isCustomMarkup ? `\n${videoMarkupOrRef}\n` : `![[${videoMarkupOrRef}]]`;
  textarea.value = fullText.substring(0, start) + insertText + fullText.substring(end);
  const newPos = start + insertText.length;
  textarea.focus();
  textarea.setSelectionRange(newPos, newPos);
  renderMarkdown();
  scheduleSave();
}

function openVideoPickerModal() {
  if (!videoPickerModal) return;
  selectedVideoFile = null;
  if (btnConfirmVideoPicker) btnConfirmVideoPicker.disabled = true;
  if (videoPickerSearch) videoPickerSearch.value = '';

  renderVideoPickerGrid('');
  videoPickerModal.classList.add('active');
  setTimeout(() => videoPickerSearch?.focus(), 80);
}

function closeVideoPickerModal() {
  videoPickerModal?.classList.remove('active');
  selectedVideoFile = null;
}

function renderVideoPickerGrid(searchTerm = '') {
  if (!videoPickerGrid) return;
  const term = searchTerm.trim().toLowerCase();

  const videoFiles = (state.notes || []).filter(f => f.type === 'video');
  const filtered = videoFiles.filter(f => {
    if (!term) return true;
    const nameMatch = (f.name || f.title || '').toLowerCase().includes(term);
    const folderMatch = (f.folder || '').toLowerCase().includes(term);
    const pathMatch = (f.filename || '').toLowerCase().includes(term);
    return nameMatch || folderMatch || pathMatch;
  });

  if (filtered.length === 0) {
    if (videoFiles.length === 0) {
      videoPickerGrid.innerHTML = `
        <div class="video-picker-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
          <div style="font-weight: 600; color: var(--text-primary);">No hay videos guardados en la bóveda</div>
          <div style="font-size: 11.5px;">Haz clic en "+ Subir Nuevo Video" o utiliza "▶ YouTube / URL Web".</div>
        </div>`;
    } else {
      videoPickerGrid.innerHTML = `
        <div class="video-picker-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <div style="font-weight: 600; color: var(--text-primary);">Sin resultados para "${escapeHtml(searchTerm)}"</div>
          <div style="font-size: 11.5px;">Intenta con otro término o limpia el buscador.</div>
        </div>`;
    }
    return;
  }

  videoPickerGrid.innerHTML = filtered.map(f => {
    const isSelected = selectedVideoFile && selectedVideoFile.filename === f.filename;
    const url = f.url || `/api/vault-raw/${encodeURI(f.filename)}`;
    const folderLabel = f.folder ? `📁 ${escapeHtml(f.folder)} • ` : '';
    const sizeLabel = formatFileSize(f.size);

    return `
      <div class="video-picker-item ${isSelected ? 'selected' : ''}" data-filename="${escapeHtml(f.filename)}" title="${escapeHtml(f.name || f.title)}">
        <div class="video-picker-thumb">
          <video src="${url}#t=0.5" preload="metadata" muted></video>
          <div class="video-picker-play-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </div>
        </div>
        <div class="video-picker-info">
          <span class="video-picker-name">${escapeHtml(f.name || f.title)}</span>
          <span class="video-picker-meta">${folderLabel}${sizeLabel}</span>
        </div>
      </div>`;
  }).join('');

  videoPickerGrid.querySelectorAll('.video-picker-item').forEach(item => {
    const filename = item.getAttribute('data-filename');
    const fileObj = filtered.find(f => f.filename === filename);

    item.addEventListener('click', () => {
      videoPickerGrid.querySelectorAll('.video-picker-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedVideoFile = fileObj;
      if (btnConfirmVideoPicker) btnConfirmVideoPicker.disabled = false;
    });

    item.addEventListener('dblclick', () => {
      selectedVideoFile = fileObj;
      confirmVideoInsertion();
    });
  });
}

function confirmVideoInsertion() {
  if (!selectedVideoFile) return;
  const videoRef = selectedVideoFile.name || selectedVideoFile.title || selectedVideoFile.filename;
  insertVideoIntoEditor(videoRef, false);
  closeVideoPickerModal();
  showToast(`Video "${videoRef}" insertado`, 'success');
}

function setupVideoPickerEventListeners() {
  // Filtro de búsqueda en vivo
  videoPickerSearch?.addEventListener('input', (e) => {
    renderVideoPickerGrid(e.target.value);
  });

  // Botón confirmar inserción
  btnConfirmVideoPicker?.addEventListener('click', confirmVideoInsertion);

  // Botón cerrar / cancelar
  btnCloseVideoPicker?.addEventListener('click', closeVideoPickerModal);

  // Cerrar al hacer clic en el backdrop exterior
  videoPickerModal?.addEventListener('click', (e) => {
    if (e.target === videoPickerModal) {
      closeVideoPickerModal();
    }
  });

  // Botón insertar por YouTube o URL externa
  btnVideoPickerUrl?.addEventListener('click', async () => {
    const url = await showPromptModal({
      title: 'Incrustar Video (YouTube o Web)',
      message: 'Ingresa el enlace de YouTube (https://youtu.be/...) o la URL de un video en internet:',
      placeholder: 'https://www.youtube.com/watch?v=...'
    });

    if (url && url.trim()) {
      const cleanUrl = url.trim();
      const ytId = extractYouTubeId(cleanUrl);

      if (ytId) {
        const iframeMarkup = `<iframe width="100%" height="360" src="https://www.youtube.com/embed/${ytId}" title="Reproductor de video de YouTube" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen style="border-radius: 8px; margin: 12px 0;"></iframe>`;
        insertVideoIntoEditor(iframeMarkup, true);
        closeVideoPickerModal();
        showToast('Video de YouTube incrustado', 'success');
      } else {
        const videoMarkup = `<video controls width="100%" src="${cleanUrl}" style="border-radius: 8px; margin: 12px 0;"></video>`;
        insertVideoIntoEditor(videoMarkup, true);
        closeVideoPickerModal();
        showToast('Video web incrustado', 'success');
      }
    }
  });

  // Botón subir nuevo video a la bóveda
  btnVideoPickerUpload?.addEventListener('click', () => {
    videoPickerFileInput?.click();
  });

  // Procesar archivo seleccionado en el input de carga de video
  videoPickerFileInput?.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const targetFolder = state.selectedFolder || (state.activeNote ? state.activeNote.folder : '');
      await uploadFilesToVault(files, targetFolder);
      videoPickerFileInput.value = '';

      // Seleccionar automáticamente el archivo recién subido
      const uploadedName = files[0].name;
      const found = (state.notes || []).find(f => (f.name === uploadedName || f.title === uploadedName) && f.type === 'video');
      if (found) {
        selectedVideoFile = found;
        if (btnConfirmVideoPicker) btnConfirmVideoPicker.disabled = false;
      }
      renderVideoPickerGrid(videoPickerSearch ? videoPickerSearch.value : '');
    }
  });
}

// ==========================================
// 13. SELECTOR DE AUDIOS DE LA BÓVEDA
// ==========================================
function insertAudioIntoEditor(audioRef) {
  const textarea = markdownInputEl;
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const fullText = textarea.value;

  const tag = `\n![[${audioRef}]]\n`;
  textarea.value = fullText.substring(0, start) + tag + fullText.substring(end);
  const newPos = start + tag.length;
  textarea.focus();
  textarea.setSelectionRange(newPos, newPos);
  renderMarkdown();
  scheduleSave();
}

function openAudioPickerModal() {
  if (!audioPickerModal) return;
  selectedAudioFile = null;
  if (btnConfirmAudioPicker) btnConfirmAudioPicker.disabled = true;
  if (audioPickerSearch) audioPickerSearch.value = '';

  renderAudioPickerGrid('');
  audioPickerModal.classList.add('active');
  setTimeout(() => audioPickerSearch?.focus(), 80);
}

function closeAudioPickerModal() {
  audioPickerModal?.classList.remove('active');
  selectedAudioFile = null;
}

function renderAudioPickerGrid(searchTerm = '') {
  if (!audioPickerGrid) return;
  const term = searchTerm.trim().toLowerCase();

  const audioFiles = (state.notes || []).filter(f => f.type === 'audio');
  const filtered = audioFiles.filter(f => {
    if (!term) return true;
    const nameMatch = (f.name || f.title || '').toLowerCase().includes(term);
    const folderMatch = (f.folder || '').toLowerCase().includes(term);
    const pathMatch = (f.filename || '').toLowerCase().includes(term);
    return nameMatch || folderMatch || pathMatch;
  });

  if (filtered.length === 0) {
    if (audioFiles.length === 0) {
      audioPickerGrid.innerHTML = `
        <div class="audio-picker-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="16" r="3"/>
          </svg>
          <div style="font-weight: 600; color: var(--text-primary);">No hay audios en esta bóveda</div>
          <div style="font-size: 11.5px;">Haz clic en "🎙️ Grabar Voz" o "+ Subir Audio" desde tu equipo.</div>
        </div>`;
    } else {
      audioPickerGrid.innerHTML = `
        <div class="audio-picker-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <div style="font-weight: 600; color: var(--text-primary);">Sin resultados para "${escapeHtml(searchTerm)}"</div>
          <div style="font-size: 11.5px;">Prueba con otro término de búsqueda.</div>
        </div>`;
    }
    return;
  }

  audioPickerGrid.innerHTML = filtered.map(f => {
    const isSelected = selectedAudioFile && (selectedAudioFile.filename === f.filename);
    const sizeLabel = f.size ? formatFileSize(f.size) : '';
    const folderLabel = f.folder ? `${f.folder} • ` : '';
    const fileUrl = f.url || `/api/vault-raw/${encodeURI(f.filename)}`;
    const isVoice = (f.name || f.title || '').toLowerCase().includes('nota-voz') || (f.name || f.title || '').toLowerCase().includes('voice');

    return `
      <div class="audio-picker-item ${isSelected ? 'selected' : ''} ${isVoice ? 'is-voice-note' : ''}" data-filename="${escapeHtml(f.filename)}">
        <div class="audio-picker-icon-badge">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            ${isVoice ? '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>' : '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'}
          </svg>
        </div>
        <div class="audio-picker-item-info">
          <span class="audio-picker-name" title="${escapeHtml(f.name || f.title)}">${escapeHtml(f.name || f.title)}</span>
          <span class="audio-picker-meta">${folderLabel}${sizeLabel}</span>
        </div>
        <audio controls preload="none" src="${fileUrl}" class="audio-picker-player" onclick="event.stopPropagation()"></audio>
      </div>`;
  }).join('');

  audioPickerGrid.querySelectorAll('.audio-picker-item').forEach(item => {
    const fn = item.getAttribute('data-filename');
    const fileObj = filtered.find(f => f.filename === fn);

    item.addEventListener('click', () => {
      audioPickerGrid.querySelectorAll('.audio-picker-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedAudioFile = fileObj;
      if (btnConfirmAudioPicker) btnConfirmAudioPicker.disabled = false;
    });

    item.addEventListener('dblclick', () => {
      selectedAudioFile = fileObj;
      confirmAudioInsertion();
    });
  });
}

function confirmAudioInsertion() {
  if (!selectedAudioFile) return;
  const audioRef = selectedAudioFile.name || selectedAudioFile.title || selectedAudioFile.filename;
  insertAudioIntoEditor(audioRef);
  closeAudioPickerModal();
  showToast(`Audio "${audioRef}" insertado`, 'success');
}

function setupAudioPickerEventListeners() {
  audioPickerSearch?.addEventListener('input', (e) => {
    renderAudioPickerGrid(e.target.value);
  });

  btnConfirmAudioPicker?.addEventListener('click', confirmAudioInsertion);
  btnCloseAudioPicker?.addEventListener('click', closeAudioPickerModal);

  audioPickerModal?.addEventListener('click', (e) => {
    if (e.target === audioPickerModal) {
      closeAudioPickerModal();
    }
  });

  btnAudioPickerRecord?.addEventListener('click', () => {
    closeAudioPickerModal();
    openVoiceRecorderModal();
  });

  btnAudioPickerUpload?.addEventListener('click', () => {
    audioPickerFileInput?.click();
  });

  audioPickerFileInput?.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const targetFolder = state.selectedFolder || (state.activeNote ? state.activeNote.folder : '');
      await uploadFilesToVault(files, targetFolder);
      audioPickerFileInput.value = '';

      const uploadedName = files[0].name;
      const found = (state.notes || []).find(f => (f.name === uploadedName || f.title === uploadedName) && f.type === 'audio');
      if (found) {
        selectedAudioFile = found;
        if (btnConfirmAudioPicker) btnConfirmAudioPicker.disabled = false;
      }
      renderAudioPickerGrid(audioPickerSearch ? audioPickerSearch.value : '');
    }
  });
}

// ==========================================
// 14. GRABADORA DE NOTAS DE VOZ (MICROPHONE)
// ==========================================
function openVoiceRecorderModal() {
  if (!voiceRecorderModal) return;
  resetVoiceRecorder();
  voiceRecorderModal.classList.add('active');
  initVoiceVisualizerCanvas();
}

function closeVoiceRecorderModal() {
  if (voiceRecState === 'recording' || voiceRecState === 'paused') {
    stopVoiceMediaTracks();
  }
  resetVoiceRecorder();
  voiceRecorderModal?.classList.remove('active');
}

function resetVoiceRecorder() {
  stopVoiceMediaTracks();
  clearInterval(voiceRecTimerInterval);
  voiceRecTimerInterval = null;
  voiceRecSeconds = 0;
  voiceRecState = 'idle';
  recordedAudioBlob = null;
  audioChunks = [];

  const recToolbarBtn = markdownToolbarEl ? markdownToolbarEl.querySelector('.rec-toolbar-btn') : null;
  recToolbarBtn?.classList.remove('is-recording-now');
  voiceRecDisplay?.classList.remove('is-recording');
  voiceRecButtonWrap?.classList.remove('is-recording');
  recVuMeter?.querySelectorAll('.vu-bar').forEach(b => {
    b.style.height = '4px';
    b.style.opacity = '0.25';
  });

  if (voiceRecTimerEl) voiceRecTimerEl.textContent = '00:00';
  if (voiceRecBadgePill) {
    voiceRecBadgePill.className = 'voice-rec-badge-pill';
  }
  if (voiceRecStatusText) voiceRecStatusText.textContent = 'LISTO PARA GRABAR';
  if (voiceRecSubControls) voiceRecSubControls.style.display = 'none';
  if (voiceRecPreviewPanel) voiceRecPreviewPanel.style.display = 'none';
  if (btnSaveVoiceRec) btnSaveVoiceRec.disabled = true;

  if (btnVoiceRecToggle) {
    btnVoiceRecToggle.className = 'voice-rec-main-btn';
    btnVoiceRecToggle.title = 'Iniciar Grabación';
    btnVoiceRecToggle.innerHTML = `
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>`;
  }

  if (voiceRecAudioPreview) {
    voiceRecAudioPreview.pause();
    voiceRecAudioPreview.src = '';
  }

  drawVoiceVisualizerIdle();
}

function stopVoiceMediaTracks() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch (e) {}
  }
  if (voiceRecStream) {
    voiceRecStream.getTracks().forEach(track => track.stop());
    voiceRecStream = null;
  }
  if (audioCtx && audioCtx.state !== 'closed') {
    try {
      audioCtx.close();
    } catch (e) {}
    audioCtx = null;
  }
  if (visualizerAnimFrame) {
    cancelAnimationFrame(visualizerAnimFrame);
    visualizerAnimFrame = null;
  }
}

function formatVoiceTimer(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

async function startVoiceRecording() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Tu navegador no soporta captura de audio desde el micrófono', 'danger');
      return;
    }

    // Solicitar stream con cancelación de eco y ganancia automática
    try {
      voiceRecStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (e1) {
      voiceRecStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    const audioTracks = voiceRecStream.getAudioTracks();
    if (!audioTracks || audioTracks.length === 0) {
      throw new Error('No se detectaron pistas de audio en el micrófono');
    }
    audioTracks.forEach(track => { track.enabled = true; });

    if (audioTracks[0].muted) {
      showToast('Aviso: Tu micrófono parece estar silenciado a nivel del sistema', 'warning', 4000);
    }

    // Probar candidatos de MIME en orden de compatibilidad
    recordedMimeType = '';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/aac'
    ];
    for (const cand of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(cand)) {
        recordedMimeType = cand;
        break;
      }
    }

    const options = recordedMimeType ? { mimeType: recordedMimeType } : {};
    mediaRecorder = new MediaRecorder(voiceRecStream, options);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      // Detener los tracks SOLO cuando MediaRecorder haya finalizado y emitido todos los fragmentos
      stopVoiceMediaTracks();

      const mime = mediaRecorder.mimeType || recordedMimeType || 'audio/webm';
      recordedAudioBlob = new Blob(audioChunks, { type: mime });
      console.log(`[Kortexa] Grabación finalizada: ${recordedAudioBlob.size} bytes (${mime})`);

      if (recordedAudioBlob.size === 0) {
        showToast('El archivo grabado está vacío (0 bytes). Verifica que tu micrófono esté conectado y con permisos concedidos.', 'danger', 6000);
        voiceRecStatusText.textContent = 'ERROR: AUDIO VACÍO';
      } else {
        voiceRecStatusText.textContent = 'GRABACIÓN LISTA';
        handleVoiceRecordingComplete(recordedAudioBlob);
      }
    };

    // Acumular trozos en búfer cada 100ms
    mediaRecorder.start(100);
    voiceRecState = 'recording';

    voiceRecSeconds = 0;
    voiceRecTimerEl.textContent = '00:00';
    voiceRecTimerInterval = setInterval(() => {
      voiceRecSeconds++;
      voiceRecTimerEl.textContent = formatVoiceTimer(voiceRecSeconds);
    }, 1000);

    voiceRecBadgePill.className = 'voice-rec-badge-pill recording';
    voiceRecStatusText.textContent = 'GRABANDO...';
    btnVoiceRecToggle.className = 'voice-rec-main-btn is-recording';
    btnVoiceRecToggle.title = 'Detener Grabación';
    btnVoiceRecToggle.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
        <rect x="5" y="5" width="14" height="14" rx="3"/>
      </svg>`;

    // Efectos visuales de grabación activa
    voiceRecDisplay?.classList.add('is-recording');
    voiceRecButtonWrap?.classList.add('is-recording');
    const recToolbarBtn = markdownToolbarEl ? markdownToolbarEl.querySelector('.rec-toolbar-btn') : null;
    recToolbarBtn?.classList.add('is-recording-now');

    voiceRecSubControls.style.display = 'flex';
    voiceRecPreviewPanel.style.display = 'none';
    if (voiceRecPauseText) voiceRecPauseText.textContent = 'Pausar';

    setupWebAudioVisualizer(voiceRecStream);

  } catch (err) {
    console.error('Error accediendo al micrófono:', err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showToast('Permiso de micrófono denegado en el navegador. Haz clic en el candado de la barra de direcciones para habilitarlo.', 'danger', 6000);
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      showToast('No se encontró ningún micrófono conectado en tu equipo.', 'danger', 5000);
    } else {
      showToast(`No se pudo iniciar el micrófono: ${err.message}`, 'danger', 5000);
    }
    resetVoiceRecorder();
  }
}

function pauseVoiceRecording() {
  const recToolbarBtn = markdownToolbarEl ? markdownToolbarEl.querySelector('.rec-toolbar-btn') : null;
  if (voiceRecState === 'recording' && mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    voiceRecState = 'paused';
    clearInterval(voiceRecTimerInterval);
    voiceRecBadgePill.className = 'voice-rec-badge-pill';
    voiceRecStatusText.textContent = 'PAUSADO';
    voiceRecDisplay?.classList.remove('is-recording');
    voiceRecButtonWrap?.classList.remove('is-recording');
    recToolbarBtn?.classList.remove('is-recording-now');
    if (voiceRecPauseText) voiceRecPauseText.textContent = 'Reanudar';
  } else if (voiceRecState === 'paused' && mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    voiceRecState = 'recording';
    voiceRecTimerInterval = setInterval(() => {
      voiceRecSeconds++;
      voiceRecTimerEl.textContent = formatVoiceTimer(voiceRecSeconds);
    }, 1000);
    voiceRecBadgePill.className = 'voice-rec-badge-pill recording';
    voiceRecStatusText.textContent = 'GRABANDO...';
    voiceRecDisplay?.classList.add('is-recording');
    voiceRecButtonWrap?.classList.add('is-recording');
    recToolbarBtn?.classList.add('is-recording-now');
    if (voiceRecPauseText) voiceRecPauseText.textContent = 'Pausar';
  }
}

function stopVoiceRecording() {
  clearInterval(voiceRecTimerInterval);
  voiceRecState = 'stopped';
  voiceRecBadgePill.className = 'voice-rec-badge-pill';
  voiceRecStatusText.textContent = 'PROCESANDO AUDIO...';

  voiceRecDisplay?.classList.remove('is-recording');
  voiceRecButtonWrap?.classList.remove('is-recording');
  const recToolbarBtn = markdownToolbarEl ? markdownToolbarEl.querySelector('.rec-toolbar-btn') : null;
  recToolbarBtn?.classList.remove('is-recording-now');
  recVuMeter?.querySelectorAll('.vu-bar').forEach(b => {
    b.style.height = '4px';
    b.style.opacity = '0.25';
  });

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.requestData();
    } catch (e) {}
    mediaRecorder.stop();
  } else {
    stopVoiceMediaTracks();
  }
}

function handleVoiceRecordingComplete(blob) {
  const url = URL.createObjectURL(blob);
  if (voiceRecAudioPreview) {
    voiceRecAudioPreview.src = url;
    try {
      voiceRecAudioPreview.load();
    } catch (e) {}
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const defaultName = `nota-voz-${yyyy}${mm}${dd}-${hh}${min}${ss}`;

  if (inputVoiceRecName) {
    inputVoiceRecName.value = defaultName;
  }

  let ext = '.weba';
  if (blob.type.includes('ogg')) ext = '.ogg';
  else if (blob.type.includes('mp4') || blob.type.includes('aac')) ext = '.m4a';
  else if (blob.type.includes('wav')) ext = '.wav';

  if (voiceRecExtTag) {
    voiceRecExtTag.textContent = ext;
  }

  voiceRecSubControls.style.display = 'none';
  voiceRecPreviewPanel.style.display = 'flex';
  if (btnSaveVoiceRec) btnSaveVoiceRec.disabled = false;

  btnVoiceRecToggle.className = 'voice-rec-main-btn';
  btnVoiceRecToggle.title = 'Volver a Grabar';
  btnVoiceRecToggle.innerHTML = `
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>`;
}

async function saveVoiceRecordingToVault() {
  if (!recordedAudioBlob) return;

  let baseName = inputVoiceRecName ? inputVoiceRecName.value.trim() : '';
  if (!baseName) {
    baseName = `nota-voz-${Date.now()}`;
  }
  baseName = baseName.replace(/[<>:"/\\|?*]/g, '').trim();

  let ext = voiceRecExtTag ? voiceRecExtTag.textContent.trim() : '.weba';
  if (!ext.startsWith('.')) ext = `.${ext}`;

  const finalFilename = baseName.endsWith(ext) ? baseName : `${baseName}${ext}`;
  const targetFolder = state.selectedFolder || (state.activeNote ? state.activeNote.folder : '');

  try {
    if (btnSaveVoiceRec) {
      btnSaveVoiceRec.disabled = true;
      btnSaveVoiceRec.textContent = 'Guardando en bóveda...';
    }

    const base64 = await fileToBase64(recordedAudioBlob);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: finalFilename,
        folder: targetFolder,
        base64
      })
    });

    if (!res.ok) throw new Error('Error en el servidor al guardar nota de voz');
    const uploadedData = await res.json();

    insertAudioIntoEditor(uploadedData.filename || finalFilename);
    closeVoiceRecorderModal();
    showToast(`Nota de voz "${finalFilename}" guardada e insertada`, 'success');

    await loadNotesAndFolders();
  } catch (err) {
    console.error('Error guardando nota de voz:', err);
    showToast(`Error guardando nota de voz: ${err.message}`, 'danger');
    if (btnSaveVoiceRec) {
      btnSaveVoiceRec.disabled = false;
      btnSaveVoiceRec.textContent = '✓ Guardar e Insertar en Nota';
    }
  }
}

function initVoiceVisualizerCanvas() {
  if (!voiceRecVisualizerCanvas) return;
  drawVoiceVisualizerIdle();
}

function drawVoiceVisualizerIdle() {
  if (!voiceRecVisualizerCanvas) return;
  const ctx = voiceRecVisualizerCanvas.getContext('2d');
  const w = voiceRecVisualizerCanvas.width;
  const h = voiceRecVisualizerCanvas.height;

  ctx.clearRect(0, 0, w, h);

  // Línea central neón con degradado suave
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(0, 242, 254, 0)');
  grad.addColorStop(0.5, 'rgba(0, 242, 254, 0.4)');
  grad.addColorStop(1, 'rgba(0, 242, 254, 0)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // Pequeñas barras idles decorativas en el centro
  const numBars = 32;
  const gap = 3;
  const barWidth = (w - (numBars - 1) * gap) / numBars;
  ctx.fillStyle = 'rgba(0, 242, 254, 0.12)';
  for (let i = 0; i < numBars; i++) {
    const x = i * (barWidth + gap);
    const distFromCenter = Math.abs(i - numBars / 2) / (numBars / 2);
    const bh = Math.max(3, (1 - distFromCenter) * 12);
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, (h - bh) / 2, barWidth, bh, 2);
    } else {
      ctx.rect(x, (h - bh) / 2, barWidth, bh);
    }
    ctx.fill();
  }
}

async function setupWebAudioVisualizer(stream) {
  if (!voiceRecVisualizerCanvas) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    if (audioCtx && audioCtx.state !== 'closed') {
      try { audioCtx.close(); } catch (e) {}
    }

    audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    const source = audioCtx.createMediaStreamSource(stream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 128;
    analyserNode.smoothingTimeConstant = 0.75;
    source.connect(analyserNode);

    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const canvasCtx = voiceRecVisualizerCanvas.getContext('2d');
    const width = voiceRecVisualizerCanvas.width;
    const height = voiceRecVisualizerCanvas.height;

    const numBars = 36;
    const gap = 3;
    const barWidth = (width - (numBars - 1) * gap) / numBars;

    function renderFrame() {
      if (voiceRecState !== 'recording' && voiceRecState !== 'paused') {
        drawVoiceVisualizerIdle();
        return;
      }

      visualizerAnimFrame = requestAnimationFrame(renderFrame);
      analyserNode.getByteFrequencyData(dataArray);

      canvasCtx.clearRect(0, 0, width, height);

      // Calcular volumen promedio para el VU meter y efectos
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const avgVol = sum / bufferLength; // 0 to 255

      // Actualizar VU meter dinámicamente con la voz
      const vuBars = recVuMeter ? recVuMeter.querySelectorAll('.vu-bar') : null;
      if (vuBars && vuBars.length > 0) {
        const activeCount = Math.floor((avgVol / 70) * vuBars.length);
        vuBars.forEach((bar, bIdx) => {
          const isActive = bIdx <= activeCount && avgVol > 4;
          const bh = isActive ? Math.min(16, 4 + (bIdx + 1) * 1.5) : 4;
          bar.style.height = `${bh}px`;
          bar.style.opacity = isActive ? '1' : '0.25';
        });
      }

      // Dibujar barras reactivas espectaculares
      for (let i = 0; i < numBars; i++) {
        const dataIdx = Math.floor((i / numBars) * (bufferLength * 0.7));
        const val = dataArray[dataIdx] || 0;
        const percent = Math.min(1, Math.max(0.06, val / 210));
        const barHeight = Math.max(4, percent * (height - 8));
        const x = i * (barWidth + gap);

        const gradient = canvasCtx.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, '#00f2fe');
        gradient.addColorStop(0.5, '#4facfe');
        gradient.addColorStop(0.85, '#f43f5e');
        gradient.addColorStop(1, '#ffffff');

        canvasCtx.fillStyle = gradient;
        canvasCtx.beginPath();
        if (canvasCtx.roundRect) {
          canvasCtx.roundRect(x, (height - barHeight) / 2, barWidth, barHeight, 2.5);
        } else {
          canvasCtx.rect(x, (height - barHeight) / 2, barWidth, barHeight);
        }
        canvasCtx.fill();
      }
    }

    renderFrame();
  } catch (e) {
    console.warn('No se pudo inicializar el visualizador de audio:', e);
  }
}

function setupVoiceRecorderEventListeners() {
  btnVoiceRecToggle?.addEventListener('click', () => {
    if (voiceRecState === 'idle' || voiceRecState === 'stopped') {
      startVoiceRecording();
    } else if (voiceRecState === 'recording' || voiceRecState === 'paused') {
      stopVoiceRecording();
    }
  });

  btnVoiceRecPause?.addEventListener('click', pauseVoiceRecording);

  btnVoiceRecDiscard?.addEventListener('click', () => {
    resetVoiceRecorder();
  });

  btnSaveVoiceRec?.addEventListener('click', saveVoiceRecordingToVault);

  btnCloseVoiceRec?.addEventListener('click', closeVoiceRecorderModal);
  btnCancelVoiceRec?.addEventListener('click', closeVoiceRecorderModal);

  voiceRecorderModal?.addEventListener('click', (e) => {
    if (e.target === voiceRecorderModal) {
      closeVoiceRecorderModal();
    }
  });
}

// ==========================================
// 15. INTEGRACIÓN FORTUNESHEET (EXCEL INTERACTIVO)
// ==========================================
function parseSheetDataFromBlock(rawString) {
  if (!rawString || !rawString.trim()) {
    return [[""]];
  }
  try {
    return JSON.parse(rawString);
  } catch (e) {
    try {
      return Function('"use strict"; return (' + rawString + ')')();
    } catch (err2) {
      console.warn('Error parseando bloque sheet:', err2);
      return [["Error", "Formato inválido"], ["Detalle", rawString.slice(0, 30)]];
    }
  }
}

function extractAllSheetBlocksFromEditor() {
  const fullText = markdownInputEl ? markdownInputEl.value : '';
  const regex = /```(?:sheet|spreadsheet|excel|fortunesheet)[^\n]*\n([\s\S]*?)```/gi;
  const blocks = [];
  let match;
  while ((match = regex.exec(fullText)) !== null) {
    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
      fullMatch: match[0],
      content: match[1].trim()
    });
  }
  return blocks;
}

function processFortuneSheetsInPreview() {
  if (!markdownPreviewEl) return;
  const codeBlocks = markdownPreviewEl.querySelectorAll('pre code');
  let sheetIndex = 0;

  codeBlocks.forEach(codeEl => {
    const className = codeEl.className || '';
    const isSheet = /\blanguage-(sheet|spreadsheet|excel|fortunesheet)\b/i.test(className);
    if (!isSheet) return;

    const preEl = codeEl.closest('pre');
    if (!preEl) return;

    const currentIdx = sheetIndex++;
    const containerId = `fs-embed-sheet-${currentIdx}-${Date.now()}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'fortunesheet-embedded-wrapper';
    wrapper.setAttribute('data-sheet-idx', currentIdx);
    wrapper.innerHTML = `
      <div class="fortunesheet-embedded-header">
        <div class="fortunesheet-title-group">
          <span class="fortunesheet-badge">EXCEL</span>
          <span class="fortunesheet-embedded-title">Hoja de Cálculo Kortexa</span>
        </div>
        <div class="fortunesheet-header-actions">
          <button type="button" class="fortunesheet-btn btn-fs-fullscreen" title="Editar en pantalla completa">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 3 21 3 21 9"/>
              <polyline points="9 21 3 21 3 15"/>
              <line x1="21" y1="3" x2="14" y2="10"/>
              <line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
            <span>Pantalla Completa</span>
          </button>
        </div>
      </div>
      <div id="${containerId}" class="fortunesheet-embedded-workbook"></div>
    `;

    preEl.replaceWith(wrapper);

    const btnFullscreen = wrapper.querySelector('.btn-fs-fullscreen');
    btnFullscreen?.addEventListener('click', () => {
      openFortuneSheetModal(currentIdx);
    });
  });

  // Montar hojas de cálculo debounced para máximo rendimiento
  clearTimeout(fortuneMountDebounceTimer);
  fortuneMountDebounceTimer = setTimeout(() => {
    mountAllEmbeddedSheets();
  }, 100);
}

async function mountAllEmbeddedSheets() {
  if (!markdownPreviewEl) return;
  if (!window.KortexaFortuneSheet || !window.KortexaFortuneSheet.mountFortuneSheet) {
    setTimeout(mountAllEmbeddedSheets, 120);
    return;
  }

  const wrappers = markdownPreviewEl.querySelectorAll('.fortunesheet-embedded-wrapper');
  const sheetBlocks = extractAllSheetBlocksFromEditor();

  wrappers.forEach((wrapper, idx) => {
    const container = wrapper.querySelector('.fortunesheet-embedded-workbook');
    if (!container) return;

    const blockData = sheetBlocks[idx];
    if (!blockData) return;

    // Evitar re-montar si el contenido no ha cambiado
    if (container.dataset.renderedHash === blockData.content) {
      return;
    }
    container.dataset.renderedHash = blockData.content;

    const parsed = parseSheetDataFromBlock(blockData.content);

    window.KortexaFortuneSheet.mountFortuneSheet(container, parsed, {
      showToolbar: false,
      showFormulaBar: true,
      showSheetTabs: true,
      onOp: (op, latestData) => {
        // Al editar celdas en la vista previa, actualizar el bloque de la nota sin destruir el DOM
        clearTimeout(container._saveTimer);
        container._saveTimer = setTimeout(() => {
          updateSheetBlockInEditor(idx, latestData, false);
        }, 600);
      }
    }).then(inst => {
      mountedSheetInstances.set(idx, inst);
    }).catch(err => {
      console.error('Error al montar FortuneSheet embebido:', err);
    });
  });
}

function updateSheetBlockInEditor(targetBlockIndex, newSheetsData, shouldReRender = false) {
  const sheetBlocks = extractAllSheetBlocksFromEditor();
  const targetBlock = sheetBlocks[targetBlockIndex];
  if (!targetBlock || !markdownInputEl) return;

  let serialized = '';
  if (window.KortexaFortuneSheet && window.KortexaFortuneSheet.fortuneSheetToClean2D) {
    const clean2D = window.KortexaFortuneSheet.fortuneSheetToClean2D(newSheetsData);
    serialized = JSON.stringify(clean2D, null, 2);
  } else {
    serialized = JSON.stringify(newSheetsData, null, 2);
  }

  const replacement = '```sheet\n' + serialized + '\n```';
  const fullText = markdownInputEl.value;
  markdownInputEl.value = fullText.substring(0, targetBlock.start) + replacement + fullText.substring(targetBlock.end);

  if (shouldReRender) {
    renderMarkdown();
  }
  // Si shouldReRender es false, no re-renderizar para no interrumpir la edición ni desmontar el DOM
  scheduleSave(shouldReRender);
}

function openFortuneSheetModal(blockIndex) {
  if (!fortunesheetModal || !fortunesheetModalWorkbook) return;
  currentModalSheetBlockIndex = blockIndex;

  const sheetBlocks = extractAllSheetBlocksFromEditor();
  const block = sheetBlocks[blockIndex];
  const initialData = block ? parseSheetDataFromBlock(block.content) : [
    ["Concepto", "Cantidad", "Precio Unitario", "Total"],
    ["Servidor Cloud", 2, 45, "=B2*C2"],
    ["Dominio Web", 1, 15, "=B3*C3"],
    ["Total Inversión", "", "", "=SUM(D2:D3)"]
  ];

  fortunesheetModal.classList.add('active');

  const mountModalSheet = () => {
    if (window.KortexaFortuneSheet && window.KortexaFortuneSheet.mountFortuneSheet) {
      window.KortexaFortuneSheet.mountFortuneSheet(fortunesheetModalWorkbook, initialData, {
        showToolbar: true,
        showFormulaBar: true,
        showSheetTabs: true
      }).then(inst => {
        activeModalFortuneSheetInstance = inst;
      }).catch(err => {
        console.error('Error montando modal de FortuneSheet:', err);
      });
    } else {
      setTimeout(mountModalSheet, 100);
    }
  };
  mountModalSheet();
}

function closeFortuneSheetModal() {
  if (!fortunesheetModal) return;
  fortunesheetModal.classList.remove('active');
  if (activeModalFortuneSheetInstance && activeModalFortuneSheetInstance.unmount) {
    try {
      activeModalFortuneSheetInstance.unmount();
    } catch (e) {}
    activeModalFortuneSheetInstance = null;
  }
  if (fortunesheetModalWorkbook) {
    fortunesheetModalWorkbook.innerHTML = '';
  }
  currentModalSheetBlockIndex = null;
}

function setupFortuneSheetEventListeners() {
  btnSaveFortunesheetModal?.addEventListener('click', () => {
    if (activeModalFortuneSheetInstance && typeof activeModalFortuneSheetInstance.getData === 'function') {
      const data = activeModalFortuneSheetInstance.getData();
      if (currentModalSheetBlockIndex !== null) {
        updateSheetBlockInEditor(currentModalSheetBlockIndex, data, true);
        showToast('Hoja de cálculo actualizada en la nota', 'success');
      }
    }
    closeFortuneSheetModal();
  });

  btnCloseFortunesheetModal?.addEventListener('click', closeFortuneSheetModal);

  fortunesheetModal?.addEventListener('click', (e) => {
    if (e.target === fortunesheetModal) {
      closeFortuneSheetModal();
    }
  });
}

function setActiveModeBtn(btn) {
  [btnModeSplit, btnModePreview, btnModeEdit].forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// Iniciar aplicación
document.addEventListener('DOMContentLoaded', init);
