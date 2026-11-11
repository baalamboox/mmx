// ==========================================================================
// KORTEXA — APLICACIÓN CLIENTE (CON SOPORTE DE SUBCARPETAS Y ÁRBOL)
// ==========================================================================

// Interceptor global de fetch para inyectar token de autenticación y manejar 401
const originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
  options = options || {};
  options.headers = options.headers || {};
  const token = localStorage.getItem('kortexa_auth_token');
  if (token) {
    if (options.headers instanceof Headers) {
      if (!options.headers.has('Authorization')) {
        options.headers.set('Authorization', `Bearer ${token}`);
      }
    } else if (Array.isArray(options.headers)) {
      if (!options.headers.some(([k]) => k.toLowerCase() === 'authorization')) {
        options.headers.push(['Authorization', `Bearer ${token}`]);
      }
    } else {
      if (!options.headers['Authorization']) {
        options.headers['Authorization'] = `Bearer ${token}`;
      }
    }
  }

  const res = await originalFetch(url, options);

  if (res.status === 401 && typeof url === 'string' && url.includes('/api/') && !url.includes('/api/auth/login') && !url.includes('/api/auth/register') && !url.includes('/api/auth/status')) {
    openAuthModal('login', 'Tu sesión ha expirado o requiere autenticación.');
  }

  return res;
};

// Estado global de la aplicación
const state = {
  currentUser: null,
  onlineUsers: new Set(),
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
const toolbarHeadingDropdown = document.getElementById('toolbar-heading-dropdown');
const toolbarHeadingTrigger = document.getElementById('toolbar-heading-trigger');
const toolbarHeadingMenu = document.getElementById('toolbar-heading-menu');
const toolbarHeadingLabel = document.getElementById('toolbar-heading-label');
const toolbarSizeDropdown = document.getElementById('toolbar-size-dropdown');
const toolbarSizeTrigger = document.getElementById('toolbar-size-trigger');
const toolbarSizeMenu = document.getElementById('toolbar-size-menu');
const toolbarSizeLabel = document.getElementById('toolbar-size-label');

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
// CONTROLADOR DE AUTENTICACIÓN
// ==========================================
const authModal = document.getElementById('auth-modal');
const tabBtnLogin = document.getElementById('tab-btn-login');
const tabBtnRegister = document.getElementById('tab-btn-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');
const loginIdentifierInput = document.getElementById('login-identifier');
const loginPasswordInput = document.getElementById('login-password');
const btnToggleLoginPwd = document.getElementById('btn-toggle-login-pwd');
const loginErrorBanner = document.getElementById('login-error-banner');
const linkGotoRegister = document.getElementById('link-goto-register');
const linkGotoLogin = document.getElementById('link-goto-login');

const registerNombresInput = document.getElementById('register-nombres');
const registerPaternoInput = document.getElementById('register-paterno');
const registerMaternoInput = document.getElementById('register-materno');
const registerEmailInput = document.getElementById('register-email');
const registerUsernameInput = document.getElementById('register-username');
const registerPasswordInput = document.getElementById('register-password');
const registerConfirmPasswordInput = document.getElementById('register-confirm-password');
const registerErrorBanner = document.getElementById('register-error-banner');
const registerSuccessBanner = document.getElementById('register-success-banner');

const sidebarUserSection = document.getElementById('sidebar-user-section');
const userAvatarInitials = document.getElementById('user-avatar-initials');
const userNameDisplay = document.getElementById('user-name-display');
const userHandleDisplay = document.getElementById('user-handle-display');
const btnUserLogout = document.getElementById('btn-user-logout');

function openAuthModal(mode = 'login', notice = null) {
  if (!authModal) return;
  authModal.style.display = 'flex';
  authModal.setAttribute('aria-hidden', 'false');

  if (loginErrorBanner) {
    if (notice && mode === 'login') {
      loginErrorBanner.textContent = notice;
      loginErrorBanner.style.display = 'block';
    } else {
      loginErrorBanner.style.display = 'none';
    }
  }

  if (registerErrorBanner) registerErrorBanner.style.display = 'none';
  if (registerSuccessBanner) registerSuccessBanner.style.display = 'none';

  switchAuthTab(mode);
}

function closeAuthModal() {
  if (!authModal) return;
  authModal.style.display = 'none';
  authModal.setAttribute('aria-hidden', 'true');
}

function switchAuthTab(mode) {
  if (mode === 'register') {
    tabBtnRegister?.classList.add('active');
    tabBtnLogin?.classList.remove('active');
    if (formRegister) formRegister.style.display = 'flex';
    if (formLogin) formLogin.style.display = 'none';
    setTimeout(() => registerNombresInput?.focus(), 50);
  } else {
    tabBtnLogin?.classList.add('active');
    tabBtnRegister?.classList.remove('active');
    if (formLogin) formLogin.style.display = 'flex';
    if (formRegister) formRegister.style.display = 'none';
    setTimeout(() => loginIdentifierInput?.focus(), 50);
  }
}

function updateUserUI(user) {
  if (!user) {
    if (sidebarUserSection) sidebarUserSection.style.display = 'none';
    return;
  }

  if (sidebarUserSection) sidebarUserSection.style.display = 'block';

  const n1 = (user.nombres || '').trim().charAt(0).toUpperCase();
  const n2 = (user.apellido_paterno || '').trim().charAt(0).toUpperCase();
  if (userAvatarInitials) userAvatarInitials.textContent = `${n1}${n2}` || 'U';

  if (userNameDisplay) {
    userNameDisplay.textContent = `${user.nombres} ${user.apellido_paterno}`.trim();
    userNameDisplay.title = `${user.nombre_completo || user.nombres} (${user.email})`;
  }

  if (userHandleDisplay) {
    userHandleDisplay.textContent = `@${user.username}`;
  }
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    if (!res.ok) {
      openAuthModal('login');
      return false;
    }
    const data = await res.json();

    if (!data.hasUsers) {
      // Sistema sin usuarios creados: mostrar pantalla de registro
      openAuthModal('register');
      if (registerErrorBanner) {
        registerErrorBanner.className = 'auth-success-banner';
        registerErrorBanner.textContent = '¡Bienvenido a Kortexa! Crea tu cuenta para comenzar a utilizar tu bóveda.';
        registerErrorBanner.style.display = 'block';
      }
      return false;
    }

    if (data.loggedIn && data.user) {
      state.currentUser = data.user;
      updateUserUI(data.user);
      closeAuthModal();
      return true;
    }

    openAuthModal('login');
    return false;
  } catch (err) {
    console.error('Error al verificar autenticación:', err);
    openAuthModal('login');
    return false;
  }
}

function setupAuthEventListeners() {
  tabBtnLogin?.addEventListener('click', () => switchAuthTab('login'));
  tabBtnRegister?.addEventListener('click', () => switchAuthTab('register'));
  linkGotoRegister?.addEventListener('click', (e) => {
    e.preventDefault();
    switchAuthTab('register');
  });
  linkGotoLogin?.addEventListener('click', (e) => {
    e.preventDefault();
    switchAuthTab('login');
  });

  btnToggleLoginPwd?.addEventListener('click', () => {
    if (!loginPasswordInput) return;
    const isPwd = loginPasswordInput.type === 'password';
    loginPasswordInput.type = isPwd ? 'text' : 'password';
  });

  formLogin?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (loginErrorBanner) loginErrorBanner.style.display = 'none';

    const usernameOrEmail = (loginIdentifierInput?.value || '').trim();
    const password = loginPasswordInput?.value || '';

    if (!usernameOrEmail || !password) {
      if (loginErrorBanner) {
        loginErrorBanner.textContent = 'Por favor ingresa usuario/correo y contraseña.';
        loginErrorBanner.style.display = 'block';
      }
      return;
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernameOrEmail, password })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        if (loginErrorBanner) {
          loginErrorBanner.textContent = data.error || 'Credenciales incorrectas.';
          loginErrorBanner.style.display = 'block';
        }
        return;
      }

      localStorage.setItem('kortexa_auth_token', data.token);
      state.currentUser = data.user;
      updateUserUI(data.user);
      closeAuthModal();
      showToast(`¡Bienvenido, ${data.user.nombres}!`, 'success');

      initWebSocketManager();
      loadUnreadMessagesSummary();
      loadFriendsData();
      const isUnlocked = await loadVaultInfo();
      if (isUnlocked) {
        await loadNotesAndFolders();
        restoreOrSelectDefaultNote();
        await loadSharedWithMe();
      }
    } catch (err) {
      if (loginErrorBanner) {
        loginErrorBanner.textContent = 'Error de conexión con el servidor.';
        loginErrorBanner.style.display = 'block';
      }
    }
  });

  formRegister?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (registerErrorBanner) {
      registerErrorBanner.className = 'auth-error-banner';
      registerErrorBanner.style.display = 'none';
    }
    if (registerSuccessBanner) registerSuccessBanner.style.display = 'none';

    const nombres = (registerNombresInput?.value || '').trim();
    const apellido_paterno = (registerPaternoInput?.value || '').trim();
    const apellido_materno = (registerMaternoInput?.value || '').trim();
    const email = (registerEmailInput?.value || '').trim();
    const username = (registerUsernameInput?.value || '').trim();
    const password = registerPasswordInput?.value || '';
    const confirm_password = registerConfirmPasswordInput?.value || '';

    if (!nombres || !apellido_paterno || !apellido_materno || !email || !username || !password) {
      if (registerErrorBanner) {
        registerErrorBanner.textContent = 'Todos los campos marcados con (*) son obligatorios.';
        registerErrorBanner.style.display = 'block';
      }
      return;
    }

    if (password !== confirm_password) {
      if (registerErrorBanner) {
        registerErrorBanner.textContent = 'Las contraseñas no coinciden. Por favor verifícalas.';
        registerErrorBanner.style.display = 'block';
      }
      registerConfirmPasswordInput?.focus();
      return;
    }

    if (password.length < 8) {
      if (registerErrorBanner) {
        registerErrorBanner.textContent = 'La contraseña debe tener un mínimo de 8 caracteres.';
        registerErrorBanner.style.display = 'block';
      }
      registerPasswordInput?.focus();
      return;
    }

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombres,
          apellido_paterno,
          apellido_materno,
          email,
          username,
          password,
          confirm_password
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        if (registerErrorBanner) {
          registerErrorBanner.textContent = data.error || 'Error al registrar usuario.';
          registerErrorBanner.style.display = 'block';
        }
        return;
      }

      localStorage.setItem('kortexa_auth_token', data.token);
      state.currentUser = data.user;
      updateUserUI(data.user);
      closeAuthModal();
      showToast(`¡Cuenta creada con éxito! Bienvenido, ${data.user.nombres}`, 'success');

      formRegister.reset();

      const isUnlocked = await loadVaultInfo();
      if (isUnlocked) {
        await loadNotesAndFolders();
        restoreOrSelectDefaultNote();
      }
    } catch (err) {
      if (registerErrorBanner) {
        registerErrorBanner.textContent = 'Error al comunicarse con el servidor.';
        registerErrorBanner.style.display = 'block';
      }
    }
  });

  btnUserLogout?.addEventListener('click', async () => {
    const confirmed = await showConfirmModal({
      title: 'Cerrar Sesión',
      message: `¿Deseas cerrar la sesión activa de ${state.currentUser?.username || 'tu cuenta'}?`,
      confirmText: 'Cerrar Sesión',
      cancelText: 'Cancelar',
      danger: true
    });

    if (!confirmed) return;

    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}

    if (wsClient) {
      try { wsClient.close(); } catch {}
      wsClient = null;
    }
    updateRealtimeStatus(false);
    toggleChatWidget(false);
    activeChatFriend = null;

    localStorage.removeItem('kortexa_auth_token');
    localStorage.removeItem('kortexa-last-note');
    state.currentUser = null;
    updateUserUI(null);

    state.notes = [];
    state.folders = [];
    state.activeNote = null;
    if (notesListEl) notesListEl.innerHTML = '';
    if (notesCountEl) notesCountEl.textContent = '0';
    if (titleInputEl) titleInputEl.value = '';
    if (markdownInputEl) markdownInputEl.value = '';
    if (markdownPreviewEl) markdownPreviewEl.innerHTML = '';

    openAuthModal('login', 'Sesión finalizada exitosamente.');
    showToast('Sesión cerrada correctamente', 'info');
  });

  // Modal de Mi Cuenta & Cambio de Contraseña
  const formChangePwd = document.getElementById('form-change-password');
  const btnCloseAccountModal = document.getElementById('btn-close-account-modal');
  const btnCancelChgPwd = document.getElementById('btn-cancel-chg-pwd');
  const btnUserSettings = document.getElementById('btn-user-settings');
  const accountModal = document.getElementById('account-modal');
  const userAvatarBadge = document.getElementById('user-avatar-badge');
  const userInfoTrigger = document.getElementById('user-info-trigger');
  const btnGeneratePassword = document.getElementById('btn-generate-password');

  const inputCurrentPwd = document.getElementById('chg-current-password');
  const inputNewPwd = document.getElementById('chg-new-password');
  const inputConfirmPwd = document.getElementById('chg-confirm-new-password');

  const capsWarnCurrent = document.getElementById('caps-lock-warning-current');
  const capsWarnNew = document.getElementById('caps-lock-warning-new');
  const matchIndicator = document.getElementById('match-indicator-badge');

  const strengthLabel = document.getElementById('chg-strength-label');
  const seg1 = document.getElementById('strength-seg-1');
  const seg2 = document.getElementById('strength-seg-2');
  const seg3 = document.getElementById('strength-seg-3');
  const seg4 = document.getElementById('strength-seg-4');

  const reqLength = document.getElementById('req-length');
  const reqCases = document.getElementById('req-cases');
  const reqNumberSym = document.getElementById('req-number-sym');
  const reqMatch = document.getElementById('req-match');

  const EYE_OPEN_SVG = `<svg class="eye-open-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const EYE_CLOSED_SVG = `<svg class="eye-closed-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

  function updateReqItem(el, isMet) {
    if (!el) return;
    const icon = el.querySelector('.req-icon');
    if (isMet) {
      el.classList.add('req-met');
      if (icon) icon.textContent = '✓';
    } else {
      el.classList.remove('req-met');
      if (icon) icon.textContent = '○';
    }
  }

  function evaluateStrengthUI() {
    const pwd = inputNewPwd ? inputNewPwd.value : '';
    const confirm = inputConfirmPwd ? inputConfirmPwd.value : '';

    const hasMinLen = pwd.length >= 8;
    const hasUpper = /[A-Z]/.test(pwd);
    const hasLower = /[a-z]/.test(pwd);
    const hasCases = hasUpper && hasLower;
    const hasNumOrSym = /[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pwd);
    const hasMatch = Boolean(pwd && confirm && pwd === confirm);

    // Actualizar checklist
    updateReqItem(reqLength, hasMinLen);
    updateReqItem(reqCases, hasCases);
    updateReqItem(reqNumberSym, hasNumOrSym);
    updateReqItem(reqMatch, hasMatch);

    // Actualizar indicador de coincidencia
    if (matchIndicator) {
      if (!confirm) {
        matchIndicator.style.display = 'none';
      } else if (hasMatch) {
        matchIndicator.style.display = 'inline-block';
        matchIndicator.className = 'account-match-pill match';
        matchIndicator.textContent = '✓ Coincide';
      } else {
        matchIndicator.style.display = 'inline-block';
        matchIndicator.className = 'account-match-pill no-match';
        matchIndicator.textContent = '✗ No coincide';
      }
    }

    // Calcular puntaje
    const segments = [seg1, seg2, seg3, seg4];
    segments.forEach(s => {
      if (s) s.className = 'strength-bar-seg';
    });

    if (!pwd) {
      if (strengthLabel) {
        strengthLabel.textContent = 'Ingresa una contraseña';
        strengthLabel.style.color = 'var(--text-muted)';
      }
      return;
    }

    let score = 0;
    if (hasMinLen) score++;
    if (hasCases) score++;
    if (hasNumOrSym) score++;
    if (pwd.length >= 12 && hasCases && hasNumOrSym) score++;

    if (score === 1) {
      if (seg1) seg1.classList.add('weak');
      if (strengthLabel) {
        strengthLabel.textContent = 'Débil';
        strengthLabel.style.color = '#ef4444';
      }
    } else if (score === 2) {
      if (seg1) seg1.classList.add('medium');
      if (seg2) seg2.classList.add('medium');
      if (strengthLabel) {
        strengthLabel.textContent = 'Regular';
        strengthLabel.style.color = '#f59e0b';
      }
    } else if (score === 3) {
      if (seg1) seg1.classList.add('good');
      if (seg2) seg2.classList.add('good');
      if (seg3) seg3.classList.add('good');
      if (strengthLabel) {
        strengthLabel.textContent = 'Buena';
        strengthLabel.style.color = '#06b6d4';
      }
    } else if (score >= 4) {
      if (seg1) seg1.classList.add('strong');
      if (seg2) seg2.classList.add('strong');
      if (seg3) seg3.classList.add('strong');
      if (seg4) seg4.classList.add('strong');
      if (strengthLabel) {
        strengthLabel.textContent = 'Excelente';
        strengthLabel.style.color = '#10b981';
      }
    }
  }

  function handleCapsLock(e, warnEl) {
    if (!warnEl) return;
    if (e.getModifierState && e.getModifierState('CapsLock')) {
      warnEl.style.display = 'inline-block';
    } else {
      warnEl.style.display = 'none';
    }
  }

  [inputCurrentPwd, inputNewPwd, inputConfirmPwd].forEach(input => {
    if (!input) return;
    const warnEl = input === inputCurrentPwd ? capsWarnCurrent : capsWarnNew;
    input.addEventListener('keyup', (e) => handleCapsLock(e, warnEl));
    input.addEventListener('keydown', (e) => handleCapsLock(e, warnEl));
  });

  inputNewPwd?.addEventListener('input', evaluateStrengthUI);
  inputConfirmPwd?.addEventListener('input', evaluateStrengthUI);

  // Generador automático de contraseñas seguras
  btnGeneratePassword?.addEventListener('click', () => {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%&*?_';
    const uppers = 'ABCDEFGHJKMNPQRSTUVWXYZ';
    const lowers = 'abcdefghjkmnpqrstuvwxyz';
    const nums = '23456789';
    const syms = '!@#$%&*?_';

    let pwd = '';
    pwd += uppers[Math.floor(Math.random() * uppers.length)];
    pwd += lowers[Math.floor(Math.random() * lowers.length)];
    pwd += nums[Math.floor(Math.random() * nums.length)];
    pwd += syms[Math.floor(Math.random() * syms.length)];

    for (let i = 4; i < 16; i++) {
      pwd += chars[Math.floor(Math.random() * chars.length)];
    }
    pwd = pwd.split('').sort(() => 0.5 - Math.random()).join('');

    if (inputNewPwd) {
      inputNewPwd.value = pwd;
      inputNewPwd.type = 'text';
    }
    if (inputConfirmPwd) {
      inputConfirmPwd.value = pwd;
      inputConfirmPwd.type = 'text';
    }

    const btnToggleNew = document.getElementById('btn-toggle-chg-new-pwd');
    const btnToggleConfirm = document.getElementById('btn-toggle-chg-confirm-pwd');
    if (btnToggleNew) btnToggleNew.innerHTML = EYE_CLOSED_SVG;
    if (btnToggleConfirm) btnToggleConfirm.innerHTML = EYE_CLOSED_SVG;

    evaluateStrengthUI();

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(pwd).then(() => {
        showToast('🔑 Contraseña segura generada y copiada al portapapeles', 'info');
      }).catch(() => {
        showToast('🔑 Contraseña segura generada en el formulario', 'info');
      });
    } else {
      showToast('🔑 Contraseña segura generada en el formulario', 'info');
    }
  });

  function openAccountModal() {
    if (!accountModal || !state.currentUser) return;

    const user = state.currentUser;
    const avatarEl = document.getElementById('account-modal-avatar');
    const fullnameEl = document.getElementById('account-modal-fullname');
    const usernameEl = document.getElementById('account-modal-username');
    const emailEl = document.getElementById('account-modal-email');
    const errBanner = document.getElementById('chg-pwd-error-banner');
    const succBanner = document.getElementById('chg-pwd-success-banner');

    if (formChangePwd) formChangePwd.reset();
    if (errBanner) errBanner.style.display = 'none';
    if (succBanner) succBanner.style.display = 'none';
    if (capsWarnCurrent) capsWarnCurrent.style.display = 'none';
    if (capsWarnNew) capsWarnNew.style.display = 'none';
    if (matchIndicator) matchIndicator.style.display = 'none';

    // Reset password types
    ['chg-current', 'chg-new', 'chg-confirm'].forEach(prefix => {
      const input = document.getElementById(`${prefix}-password`);
      const btn = document.getElementById(`btn-toggle-${prefix}-pwd`);
      if (input) input.type = 'password';
      if (btn) btn.innerHTML = EYE_OPEN_SVG;
    });

    evaluateStrengthUI();

    const n1 = (user.nombres || '').trim().charAt(0).toUpperCase();
    const n2 = (user.apellido_paterno || '').trim().charAt(0).toUpperCase();
    if (avatarEl) avatarEl.textContent = `${n1}${n2}` || 'U';
    if (fullnameEl) fullnameEl.textContent = user.nombre_completo || `${user.nombres} ${user.apellido_paterno} ${user.apellido_materno || ''}`.trim();
    if (usernameEl) usernameEl.textContent = `@${user.username}`;
    if (emailEl) emailEl.textContent = user.email;

    accountModal.classList.add('active');
    accountModal.setAttribute('aria-hidden', 'false');
    switchAccountTab('security');
    loadMcpSettings();
    setTimeout(() => {
      document.getElementById('chg-current-password')?.focus();
    }, 80);
  }

  function closeAccountModal() {
    if (accountModal) {
      accountModal.classList.remove('active');
      accountModal.setAttribute('aria-hidden', 'true');
    }
  }

  btnUserSettings?.addEventListener('click', openAccountModal);
  userAvatarBadge?.addEventListener('click', openAccountModal);
  userInfoTrigger?.addEventListener('click', openAccountModal);
  btnCloseAccountModal?.addEventListener('click', closeAccountModal);
  btnCancelChgPwd?.addEventListener('click', closeAccountModal);
  accountModal?.addEventListener('click', (e) => {
    if (e.target === accountModal) closeAccountModal();
  });

  // Pestañas del Modal de Cuenta
  const btnTabSecurity = document.getElementById('btn-account-tab-security');
  const btnTabMcp = document.getElementById('btn-account-tab-mcp');
  const panelSecurity = document.getElementById('account-panel-security');
  const panelMcp = document.getElementById('account-panel-mcp');

  function switchAccountTab(tabName) {
    if (tabName === 'security') {
      btnTabSecurity?.classList.add('active');
      btnTabMcp?.classList.remove('active');
      if (panelSecurity) {
        panelSecurity.classList.add('active');
        panelSecurity.style.display = 'flex';
      }
      if (panelMcp) {
        panelMcp.classList.remove('active');
        panelMcp.style.display = 'none';
      }
    } else if (tabName === 'mcp') {
      btnTabMcp?.classList.add('active');
      btnTabSecurity?.classList.remove('active');
      if (panelMcp) {
        panelMcp.classList.add('active');
        panelMcp.style.display = 'flex';
      }
      if (panelSecurity) {
        panelSecurity.classList.remove('active');
        panelSecurity.style.display = 'none';
      }
      loadMcpSettings();
    }
  }

  btnTabSecurity?.addEventListener('click', () => switchAccountTab('security'));
  btnTabMcp?.addEventListener('click', () => switchAccountTab('mcp'));
  document.getElementById('btn-close-mcp-panel')?.addEventListener('click', closeAccountModal);

  // Lógica de Integración MCP
  const toggleMcpEnabled = document.getElementById('mcp-toggle-switch');
  const mcpTabPill = document.getElementById('account-mcp-tab-pill');
  const mcpStatusBadge = document.getElementById('mcp-status-text-badge');
  const mcpTokenInput = document.getElementById('mcp-token-input');
  const btnToggleMcpToken = document.getElementById('btn-toggle-mcp-token');
  const btnCopyMcpToken = document.getElementById('btn-copy-mcp-token');
  const btnRegenMcpToken = document.getElementById('btn-regen-mcp-token');
  const btnCopyMcpConfig = document.getElementById('btn-copy-mcp-config');
  const mcpConfigCode = document.getElementById('mcp-config-snippet-code');
  const mcpDetailsSection = document.getElementById('mcp-config-details-section');

  let currentMcpConfig = null;

  function updateMcpUI(enabled, token, config) {
    const isEn = Boolean(enabled);
    if (toggleMcpEnabled) toggleMcpEnabled.checked = isEn;

    if (mcpTabPill) {
      mcpTabPill.className = `account-mcp-status-pill ${isEn ? 'active' : 'inactive'}`;
      mcpTabPill.textContent = isEn ? 'Activo' : 'Inactivo';
    }

    if (mcpStatusBadge) {
      mcpStatusBadge.className = `account-mcp-status-pill ${isEn ? 'active' : 'inactive'}`;
      mcpStatusBadge.textContent = isEn ? 'Habilitado' : 'Deshabilitado';
    }

    if (mcpTokenInput && token) {
      mcpTokenInput.value = token;
    }

    if (config) {
      currentMcpConfig = config;
      if (mcpConfigCode) {
        mcpConfigCode.textContent = JSON.stringify(config, null, 2);
      }
    }

    if (mcpDetailsSection) {
      mcpDetailsSection.style.opacity = isEn ? '1' : '0.45';
      mcpDetailsSection.style.pointerEvents = isEn ? 'auto' : 'none';
    }
  }

  async function loadMcpSettings() {
    try {
      const res = await fetch('/api/user/mcp-settings');
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) {
        updateMcpUI(data.mcp_enabled, data.mcp_token, data.config_snippet);
      }
    } catch (err) {
      console.error('Error al cargar configuración MCP:', err);
    }
  }

  toggleMcpEnabled?.addEventListener('change', async () => {
    const isEnabled = toggleMcpEnabled.checked;
    try {
      const res = await fetch('/api/user/mcp-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: isEnabled })
      });
      const data = await res.json();
      if (data.success) {
        updateMcpUI(data.mcp_enabled, mcpTokenInput?.value, currentMcpConfig);
        showToast(data.message, isEnabled ? 'success' : 'info');
      } else {
        toggleMcpEnabled.checked = !isEnabled;
        showToast(data.error || 'No se pudo cambiar el estado MCP', 'error');
      }
    } catch {
      toggleMcpEnabled.checked = !isEnabled;
      showToast('Error de conexión al actualizar MCP', 'error');
    }
  });

  btnToggleMcpToken?.addEventListener('click', () => {
    if (!mcpTokenInput) return;
    const isPwd = mcpTokenInput.type === 'password';
    mcpTokenInput.type = isPwd ? 'text' : 'password';
    btnToggleMcpToken.innerHTML = isPwd ? EYE_CLOSED_SVG : EYE_OPEN_SVG;
  });

  btnCopyMcpToken?.addEventListener('click', () => {
    if (!mcpTokenInput || !mcpTokenInput.value) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(mcpTokenInput.value).then(() => {
        showToast('📋 Token de acceso MCP copiado', 'info');
      });
    }
  });

  btnRegenMcpToken?.addEventListener('click', async () => {
    if (!confirm('¿Estás seguro de que deseas regenerar el token MCP? El token anterior dejará de funcionar en tus clientes IA.')) {
      return;
    }
    try {
      const res = await fetch('/api/user/mcp-regenerate-token', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        if (mcpTokenInput) mcpTokenInput.value = data.mcp_token;
        if (currentMcpConfig?.mcpServers?.kortexa?.env) {
          currentMcpConfig.mcpServers.kortexa.env.VAULT_AUTH_TOKEN = data.mcp_token;
          if (mcpConfigCode) {
            mcpConfigCode.textContent = JSON.stringify(currentMcpConfig, null, 2);
          }
        }
        showToast('🔑 Nuevo token MCP generado exitosamente', 'success');
      } else {
        showToast(data.error || 'No se pudo regenerar el token', 'error');
      }
    } catch {
      showToast('Error de conexión al regenerar token', 'error');
    }
  });

  btnCopyMcpConfig?.addEventListener('click', () => {
    if (!mcpConfigCode || !mcpConfigCode.textContent) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(mcpConfigCode.textContent).then(() => {
        showToast('📋 Configuración JSON de Claude Desktop copiada', 'success');
      });
    }
  });

  // Toggles de contraseña en modal de cuenta con cambio de icono SVG
  ['chg-current', 'chg-new', 'chg-confirm'].forEach(prefix => {
    const input = document.getElementById(`${prefix}-password`);
    const btn = document.getElementById(`btn-toggle-${prefix}-pwd`);
    btn?.addEventListener('click', () => {
      if (!input) return;
      const isPwd = input.type === 'password';
      input.type = isPwd ? 'text' : 'password';
      btn.innerHTML = isPwd ? EYE_CLOSED_SVG : EYE_OPEN_SVG;
    });
  });

  formChangePwd?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBanner = document.getElementById('chg-pwd-error-banner');
    const succBanner = document.getElementById('chg-pwd-success-banner');
    const btnSubmit = document.getElementById('btn-submit-chg-pwd');
    const btnText = document.getElementById('btn-submit-chg-pwd-text');

    if (errBanner) errBanner.style.display = 'none';
    if (succBanner) succBanner.style.display = 'none';

    const currentPassword = inputCurrentPwd?.value || '';
    const newPassword = inputNewPwd?.value || '';
    const confirmNewPassword = inputConfirmPwd?.value || '';

    if (!currentPassword) {
      if (errBanner) {
        errBanner.textContent = 'Por favor ingresa tu contraseña actual.';
        errBanner.style.display = 'block';
      }
      return;
    }

    if (!newPassword || newPassword.length < 8) {
      if (errBanner) {
        errBanner.textContent = 'La nueva contraseña debe tener al menos 8 caracteres.';
        errBanner.style.display = 'block';
      }
      return;
    }

    if (newPassword !== confirmNewPassword) {
      if (errBanner) {
        errBanner.textContent = 'La confirmación de la nueva contraseña no coincide.';
        errBanner.style.display = 'block';
      }
      return;
    }

    if (currentPassword === newPassword) {
      if (errBanner) {
        errBanner.textContent = 'La nueva contraseña debe ser distinta a la contraseña actual.';
        errBanner.style.display = 'block';
      }
      return;
    }

    try {
      if (btnSubmit) btnSubmit.disabled = true;
      if (btnText) btnText.textContent = 'Actualizando...';

      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, confirmNewPassword })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        if (errBanner) {
          errBanner.textContent = data.error || 'No se pudo actualizar la contraseña.';
          errBanner.style.display = 'block';
        }
        return;
      }

      formChangePwd.reset();
      evaluateStrengthUI();
      if (succBanner) {
        succBanner.textContent = '¡Contraseña actualizada con éxito!';
        succBanner.style.display = 'block';
      }
      showToast('Contraseña actualizada con éxito', 'success');

      setTimeout(() => {
        closeAccountModal();
      }, 1500);
    } catch (err) {
      if (errBanner) {
        errBanner.textContent = 'Error de conexión con el servidor.';
        errBanner.style.display = 'block';
      }
    } finally {
      if (btnSubmit) btnSubmit.disabled = false;
      if (btnText) btnText.textContent = 'Guardar Contraseña';
    }
  });
}

// ==========================================
// 1. INICIALIZACIÓN
// ==========================================
async function init() {
  applyTheme(state.theme);
  setupEventListeners();
  setupAuthEventListeners();
  setupChatWidgetEventListeners();
  setupSharedDrawerEventListeners();
  setupEmojiPickers();

  const isAuth = await checkAuthStatus();
  if (isAuth) {
    initWebSocketManager();
    loadUnreadMessagesSummary();
    const isUnlocked = await loadVaultInfo();
    if (isUnlocked) {
      await loadNotesAndFolders();
      restoreOrSelectDefaultNote();
      await loadSharedWithMe();
    }
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
    state.isVaultShared = !!data.isShared;
    state.vaultPermission = data.permission || 'write';

    const vaultNameEl = document.getElementById('vault-display-name');
    const treeVaultEl = document.getElementById('tree-vault-name');
    const vaultIndicatorEl = document.getElementById('vault-status-indicator');

    const displayName = data.displayName || data.name;
    if (vaultNameEl) vaultNameEl.textContent = displayName;
    if (treeVaultEl) treeVaultEl.textContent = (data.name || '').toUpperCase();
    if (vaultIndicatorEl) {
      const lockLabel = data.encrypted ? ' (Protegida AES-256)' : '';
      const sharedLabel = data.isShared ? ` [Compartida - ${data.permission === 'write' ? 'Edición' : 'Lectura'}]` : '';
      vaultIndicatorEl.title = `Bóveda activa: ${displayName}${lockLabel}${sharedLabel} (${data.path}) - Clic para gestionar`;
    }

    // Actualizar botones de candado
    updateLockButtons(data.encrypted, data.locked);

    // Actualizar nombre en trigger del dropdown personalizado
    if (vaultDropdownLabel) {
      vaultDropdownLabel.textContent = displayName;
      vaultDropdownLabel.title = `Bóveda activa: ${displayName}`;
    }

    // Actualizar items del dropdown personalizado de bóvedas
    if (vaultDropdownMenu && vaultsData && Array.isArray(vaultsData.vaults)) {
      vaultDropdownMenu.innerHTML = '';

      vaultsData.vaults.forEach(v => {
        const item = document.createElement('div');
        item.className = `custom-vault-item ${v.isActive ? 'active' : ''}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', v.isActive ? 'true' : 'false');
        item.title = `Cambiar a tu bóveda "${v.name}"`;

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

      // Bóvedas compartidas conmigo
      if (vaultsData.sharedVaults && vaultsData.sharedVaults.length > 0) {
        const sharedHeader = document.createElement('div');
        sharedHeader.className = 'custom-vault-section-title';
        sharedHeader.textContent = 'COMPARTIDAS CONMIGO';
        vaultDropdownMenu.appendChild(sharedHeader);

        vaultsData.sharedVaults.forEach(sv => {
          const item = document.createElement('div');
          item.className = `custom-vault-item shared ${sv.isActive ? 'active' : ''}`;
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', sv.isActive ? 'true' : 'false');
          item.title = `Cambiar a la bóveda compartida "${sv.displayName}"`;

          const permIcon = sv.permission === 'write' ? '✍️' : '👁️';

          item.innerHTML = `
            <div class="custom-vault-item-left">
              <svg class="custom-vault-item-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="color: #818cf8;">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
              <span class="custom-vault-item-name" style="font-weight: 600;">${escapeHtml(sv.name)}</span>
              <span class="custom-vault-item-owner" style="font-size: 10px; color: var(--text-muted);">@${escapeHtml(sv.owner.username)}</span>
            </div>
            <div class="custom-vault-item-right" style="gap: 6px;">
              <span style="font-size: 10.5px;" title="${sv.permission === 'write' ? 'Edición permitida' : 'Solo lectura'}">${permIcon}</span>
              <svg class="custom-vault-item-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
          `;

          item.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeVaultDropdown();
            if (!sv.isActive) {
              await switchVault(null, sv.shareId);
            }
          });

          vaultDropdownMenu.appendChild(item);
        });
      }

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

  const btnDecrypt = document.getElementById('btn-decrypt-vault');
  if (btnDecrypt) {
    btnDecrypt.style.display = (encrypted && !locked) ? 'flex' : 'none';
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
  const currentName = state.activeVault || document.getElementById('vault-dropdown-label')?.textContent || 'vault';
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

async function switchVault(vaultName, shareId = null) {
  try {
    const payload = shareId ? { shareId } : { name: vaultName };
    const res = await fetch('/api/vault/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Error al cambiar de bóveda', 'danger');
      return;
    }

    showToast(`Bóveda cambiada a "${data.displayName || data.name}"`, 'info');
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
      if (res.status === 423) {
        showLockScreen(state.activeVault);
        return;
      }
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

  // Si es una nota compartida por otro usuario
  if (state.activeNote.isSharedWithMe) {
    if (state.activeNote.permission !== 'write') {
      setSaveStatus('Solo Lectura');
      return;
    }
    setSaveStatus('Guardando...', true);
    try {
      const res = await fetch('/api/shared-notes/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          share_id: state.activeNote.shareId,
          sub_path: state.activeNote.subPath || '',
          content: currentContent
        })
      });
      if (!res.ok) throw new Error('Error al guardar');
      setSaveStatus('Guardado');
    } catch (err) {
      setSaveStatus('Error al guardar');
      showToast('Error al guardar cambios en la nota compartida', 'danger');
    }
    return;
  }

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

  // Protección contra datos cifrados crudos / binarios KENC (evita congelamiento de regex y KaTeX)
  if (rawText && (rawText.startsWith('KENC') || (rawText.charCodeAt(0) === 0x4b && rawText.charCodeAt(1) === 0x45 && rawText.charCodeAt(2) === 0x4e && rawText.charCodeAt(3) === 0x43))) {
    markdownPreviewEl.innerHTML = `
      <div style="padding: 40px 20px; text-align: center; color: var(--danger);">
        <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom: 12px; opacity: 0.85;">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <h3 style="font-size: 16px; margin-bottom: 8px; color: var(--text-main);">Archivo Cifrado con AES-256</h3>
        <p style="color: var(--text-muted); font-size: 13px; max-width: 440px; margin: 0 auto 16px; line-height: 1.5;">
          Este archivo está protegido criptográficamente y la bóveda está bloqueada. Ingrese la contraseña de la bóveda para descifrarlo de forma segura.
        </p>
        <button id="btn-unlock-preview-inline" class="btn btn-primary" style="padding: 8px 18px; font-size: 13px; font-weight: 600; cursor: pointer; border-radius: 8px;">
          Desbloquear Bóveda
        </button>
      </div>
    `;
    const btnUnlock = document.getElementById('btn-unlock-preview-inline');
    if (btnUnlock) {
      btnUnlock.addEventListener('click', () => showLockScreen(state.activeVault));
    }
    return;
  }

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

  // 4. Extracción de Diagramas Mermaid (```mermaid ... ```) para proteger su código
  const mermaidBlocks = [];
  processedText = processedText.replace(/```mermaid\s*([\s\S]*?)```/gi, (match, code) => {
    const placeholder = `%%KORTEXA_MERMAID_BLOCK_${mermaidBlocks.length}%%`;
    mermaidBlocks.push(code.trim());
    return `\n\n${placeholder}\n\n`;
  });

  // 5. Extracción de Ecuaciones Matemáticas KaTeX (LaTeX) para protegerlas del parser Markdown
  const mathBlocks = [];
  processedText = processedText.replace(/\$\$([\s\S]*?)\$\$/g, (match, expr) => {
    const placeholder = `%%KORTEXA_MATH_BLOCK_${mathBlocks.length}%%`;
    mathBlocks.push(expr);
    return `\n\n${placeholder}\n\n`;
  });

  const mathInlines = [];
  processedText = processedText.replace(/(?<!\\)\$([^\$\n]+?)(?<!\\)\$/g, (match, expr) => {
    const placeholder = `%%KORTEXA_MATH_INLINE_${mathInlines.length}%%`;
    mathInlines.push(expr);
    return placeholder;
  });

  // Renderizar Markdown a HTML con Marked
  let parsedHtml = marked.parse(processedText);

  // Reinsertar Diagramas Mermaid
  mermaidBlocks.forEach((code, idx) => {
    const placeholder = `%%KORTEXA_MERMAID_BLOCK_${idx}%%`;
    const diagramId = `mermaid-diag-${idx}-${Math.random().toString(36).substring(2, 7)}`;
    const wrapperHtml = `<div class="mermaid-wrapper" data-diagram-id="${diagramId}">
      <div class="mermaid-toolbar">
        <button type="button" class="mermaid-tool-btn btn-diagram-zoom-in" title="Acercar (+)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button type="button" class="mermaid-tool-btn btn-diagram-zoom-out" title="Alejar (-)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button type="button" class="mermaid-tool-btn btn-diagram-zoom-reset" title="Restablecer (100%)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        </button>
        <button type="button" class="mermaid-tool-btn btn-diagram-fullscreen" title="Pantalla Completa (⛶)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        </button>
      </div>
      <div class="mermaid-viewport">
        <div class="mermaid" id="${diagramId}" data-code="${encodeURIComponent(code)}">${escapeHtml(code)}</div>
      </div>
    </div>`;
    parsedHtml = parsedHtml.replace(new RegExp(`<p>\\s*${placeholder}\\s*<\\/p>`, 'g'), () => wrapperHtml);
    parsedHtml = parsedHtml.replace(placeholder, () => wrapperHtml);
  });

  // Reinsertar Ecuaciones en Bloque KaTeX
  mathBlocks.forEach((expr, idx) => {
    const placeholder = `%%KORTEXA_MATH_BLOCK_${idx}%%`;
    let rendered = '';
    if (window.katex) {
      try {
        rendered = `<div class="katex-display-wrapper">${window.katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false })}</div>`;
      } catch (err) {
        rendered = `<div class="katex-error-wrapper">Error LaTeX: ${escapeHtml(expr)}</div>`;
      }
    } else {
      rendered = `<pre class="katex-fallback">$$${escapeHtml(expr)}$$</pre>`;
    }
    parsedHtml = parsedHtml.replace(new RegExp(`<p>\\s*${placeholder}\\s*<\\/p>`, 'g'), () => rendered);
    parsedHtml = parsedHtml.replace(placeholder, () => rendered);
  });

  // Reinsertar Ecuaciones en Línea KaTeX
  mathInlines.forEach((expr, idx) => {
    const placeholder = `%%KORTEXA_MATH_INLINE_${idx}%%`;
    let rendered = '';
    if (window.katex) {
      try {
        rendered = `<span class="katex-inline-wrapper">${window.katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false })}</span>`;
      } catch (err) {
        rendered = `<span class="katex-error-wrapper">$${escapeHtml(expr)}$</span>`;
      }
    } else {
      rendered = `<code class="katex-fallback">$${escapeHtml(expr)}$</code>`;
    }
    parsedHtml = parsedHtml.replace(placeholder, () => rendered);
  });

  markdownPreviewEl.innerHTML = parsedHtml;

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

  // 5. Renderizar Diagramas Mermaid (Flujo, ER, Clases, etc.)
  renderMermaidDiagramsInPreview();
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
          <button class="folder-share-btn" title="Compartir carpeta ${subNode.name}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
          </button>
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
        const shareBtn = e.target.closest('.folder-share-btn');
        if (shareBtn) {
          e.stopPropagation();
          openShareModalForResource({
            path: subNode.fullPath,
            title: subNode.name,
            type: 'folder'
          });
          return;
        }

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

  // Refrescar diagramas Mermaid al cambiar de tema (claro / oscuro)
  if (typeof renderMermaidDiagramsInPreview === 'function') {
    renderMermaidDiagramsInPreview();
  }

  // Refrescar hojas de cálculo FortuneSheet al cambiar de tema
  notifyFortuneSheetsThemeChange();
}

function notifyFortuneSheetsThemeChange() {
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
    const canvases = document.querySelectorAll('.fortune-sheet-canvas');
    canvases.forEach(canvas => {
      canvas.style.transform = 'translateZ(0)';
    });
  }, 60);
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

  // Compartir bóveda completa
  const btnShareVault = document.getElementById('btn-share-vault');
  btnShareVault?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeVaultMoreMenu();
    if (state.isSharedVault) {
      showToast('Esta bóveda es compartida. Solo el propietario puede administrar los accesos.', 'info');
      return;
    }
    if (window.openShareModalForResource) {
      window.openShareModalForResource({
        path: '',
        title: state.activeVault || 'Bóveda Principal',
        type: 'vault'
      });
    }
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
  const btnDecryptVault = document.getElementById('btn-decrypt-vault');
  btnDecryptVault?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeVaultMoreMenu();
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
  setupMathEquationEventListeners();
  setupDiagramEventListeners();
  setupDiagramFullscreenEventListeners();
  setupShareModalEventListeners();

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

    case 'math': {
      openMathEquationModal(selectedText);
      return;
    }

    case 'diagram': {
      openDiagramModal(selectedText);
      return;
    }

    case 'record-audio': {
      openVoiceRecorderModal();
      return;
    }

    case 'emoji': {
      toggleEditorEmojiPopover();
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

  // Control de apertura/cierre de los dropdowns del toolbar (estilo selector de bóvedas)
  function toggleToolbarHeadingDropdown(e) {
    if (e) e.stopPropagation();
    const isOpen = toolbarHeadingDropdown?.classList.contains('open');
    closeAllToolbarDropdowns();
    if (!isOpen && toolbarHeadingDropdown) {
      toolbarHeadingDropdown.classList.add('open');
      toolbarHeadingTrigger?.setAttribute('aria-expanded', 'true');
    }
  }

  function toggleToolbarSizeDropdown(e) {
    if (e) e.stopPropagation();
    const isOpen = toolbarSizeDropdown?.classList.contains('open');
    closeAllToolbarDropdowns();
    if (!isOpen && toolbarSizeDropdown) {
      toolbarSizeDropdown.classList.add('open');
      toolbarSizeTrigger?.setAttribute('aria-expanded', 'true');
    }
  }

  function closeAllToolbarDropdowns() {
    if (toolbarHeadingDropdown) {
      toolbarHeadingDropdown.classList.remove('open');
      toolbarHeadingTrigger?.setAttribute('aria-expanded', 'false');
    }
    if (toolbarSizeDropdown) {
      toolbarSizeDropdown.classList.remove('open');
      toolbarSizeTrigger?.setAttribute('aria-expanded', 'false');
    }
  }

  const headingLabelsMap = {
    p: 'Párrafo Normal',
    h1: 'Título 1 (H1)',
    h2: 'Título 2 (H2)',
    h3: 'Título 3 (H3)',
    h4: 'Título 4 (H4)',
    h5: 'Título 5 (H5)',
    h6: 'Título 6 (H6)'
  };

  const sizeLabelsMap = {
    normal: 'Tamaño Normal',
    huge: 'Muy Grande (160%)',
    large: 'Grande (135%)',
    medium: 'Mediano (115%)',
    small: 'Pequeño (85%)'
  };

  function setToolbarHeadingUI(val) {
    if (toolbarHeadingLabel && headingLabelsMap[val]) {
      toolbarHeadingLabel.textContent = headingLabelsMap[val];
    }
    document.querySelectorAll('#toolbar-heading-menu .custom-toolbar-item').forEach(it => {
      it.classList.toggle('active', it.getAttribute('data-value') === val);
    });
    if (toolbarHeadingSelect) toolbarHeadingSelect.value = val;
  }

  function setToolbarSizeUI(val) {
    if (toolbarSizeLabel && sizeLabelsMap[val]) {
      toolbarSizeLabel.textContent = sizeLabelsMap[val];
    }
    document.querySelectorAll('#toolbar-size-menu .custom-toolbar-item').forEach(it => {
      it.classList.toggle('active', it.getAttribute('data-value') === val);
    });
    if (toolbarSizeSelect) toolbarSizeSelect.value = val;
  }

  // Eventos de apertura de dropdowns
  toolbarHeadingTrigger?.addEventListener('click', toggleToolbarHeadingDropdown);
  toolbarSizeTrigger?.addEventListener('click', toggleToolbarSizeDropdown);

  // Selección de opciones de Encabezado
  document.querySelectorAll('#toolbar-heading-menu .custom-toolbar-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = item.getAttribute('data-value') || 'p';
      applyMarkdownFormat('heading', val);
      setToolbarHeadingUI(val);
      closeAllToolbarDropdowns();
      markdownInputEl?.focus();
    });
  });

  // Selección de opciones de Tamaño
  document.querySelectorAll('#toolbar-size-menu .custom-toolbar-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = item.getAttribute('data-value') || 'normal';
      applyMarkdownFormat('size', val);
      setToolbarSizeUI(val);
      closeAllToolbarDropdowns();
      markdownInputEl?.focus();
    });
  });

  // Sincronización si cambian selects nativos (por compatibilidad o scripts)
  toolbarHeadingSelect?.addEventListener('change', () => {
    const val = toolbarHeadingSelect.value;
    applyMarkdownFormat('heading', val);
    setToolbarHeadingUI(val);
  });

  toolbarSizeSelect?.addEventListener('change', () => {
    const val = toolbarSizeSelect.value;
    applyMarkdownFormat('size', val);
    setToolbarSizeUI(val);
  });

  // Cerrar al hacer clic fuera o presionar Escape
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#toolbar-heading-dropdown') && !e.target.closest('#toolbar-size-dropdown')) {
      closeAllToolbarDropdowns();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllToolbarDropdowns();
    }
  });

  // Detección contextual dinámica según la línea en la que se ubica el cursor
  function updateToolbarFromCursor() {
    if (!markdownInputEl) return;
    const start = markdownInputEl.selectionStart;
    const fullText = markdownInputEl.value;
    const lineStart = fullText.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = fullText.indexOf('\n', start);
    if (lineEnd === -1) lineEnd = fullText.length;
    const currentLine = fullText.substring(lineStart, lineEnd).trimStart();

    let hVal = 'p';
    let sVal = 'normal';
    if (currentLine.startsWith('# ')) {
      hVal = 'h1';
      sVal = 'huge';
    } else if (currentLine.startsWith('## ')) {
      hVal = 'h2';
      sVal = 'large';
    } else if (currentLine.startsWith('### ')) {
      hVal = 'h3';
      sVal = 'medium';
    } else if (currentLine.startsWith('#### ')) {
      hVal = 'h4';
    } else if (currentLine.startsWith('##### ')) {
      hVal = 'h5';
    } else if (currentLine.startsWith('###### ')) {
      hVal = 'h6';
    }

    setToolbarHeadingUI(hVal);
    setToolbarSizeUI(sVal);
  }

  markdownInputEl?.addEventListener('keyup', updateToolbarFromCursor);
  markdownInputEl?.addEventListener('click', updateToolbarFromCursor);
  markdownInputEl?.addEventListener('select', updateToolbarFromCursor);

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

// ==========================================
// 15. ASISTENTE DE ECUACIONES MATEMÁTICAS (KATEX / LATEX)
// ==========================================
let currentMathMode = 'block'; // 'block' | 'inline'

function openMathEquationModal(initialText = '') {
  const modal = document.getElementById('math-equation-modal');
  const input = document.getElementById('math-equation-input');
  if (!modal || !input) return;

  // Si había texto seleccionado, quitar posibles delimitadores $ o $$
  let cleaned = (initialText || '').trim();
  if (cleaned.startsWith('$$') && cleaned.endsWith('$$')) {
    cleaned = cleaned.substring(2, cleaned.length - 2).trim();
    currentMathMode = 'block';
  } else if (cleaned.startsWith('$') && cleaned.endsWith('$')) {
    cleaned = cleaned.substring(1, cleaned.length - 1).trim();
    currentMathMode = 'inline';
  } else if (cleaned) {
    currentMathMode = cleaned.includes('\n') ? 'block' : 'inline';
  } else {
    currentMathMode = 'block';
  }

  input.value = cleaned || 'f(x) = \\int_{0}^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}';
  updateMathModeUI();
  updateMathEquationPreview();

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => {
    input.focus();
    input.select();
  }, 60);
}

function closeMathEquationModal() {
  const modal = document.getElementById('math-equation-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
  }
  markdownInputEl?.focus();
}

function updateMathModeUI() {
  const btnBlock = document.getElementById('math-mode-block');
  const btnInline = document.getElementById('math-mode-inline');
  if (btnBlock) btnBlock.classList.toggle('active', currentMathMode === 'block');
  if (btnInline) btnInline.classList.toggle('active', currentMathMode === 'inline');
}

function updateMathEquationPreview() {
  const input = document.getElementById('math-equation-input');
  const preview = document.getElementById('math-equation-preview');
  if (!input || !preview) return;

  const raw = input.value.trim();
  if (!raw) {
    preview.innerHTML = '<span class="math-preview-placeholder">Escribe una fórmula o presiona una plantilla para previsualizar...</span>';
    return;
  }

  if (window.katex) {
    try {
      const isBlock = currentMathMode === 'block';
      const rendered = window.katex.renderToString(raw, {
        displayMode: isBlock,
        throwOnError: false
      });
      preview.innerHTML = rendered;
    } catch (e) {
      preview.innerHTML = `<span class="katex-error-wrapper">Error de sintaxis: ${escapeHtml(e.message)}</span>`;
    }
  } else {
    preview.innerHTML = `<code>${escapeHtml(raw)}</code>`;
  }
}

function insertMathEquationIntoEditor() {
  const input = document.getElementById('math-equation-input');
  if (!input || !markdownInputEl) return;

  const code = input.value.trim();
  if (!code) {
    closeMathEquationModal();
    return;
  }

  const isBlock = currentMathMode === 'block';
  const snippet = isBlock ? `\n$$\n${code}\n$$\n` : `$${code}$`;

  const textarea = markdownInputEl;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const fullText = textarea.value;

  textarea.value = fullText.substring(0, start) + snippet + fullText.substring(end);
  const newPos = start + snippet.length;
  textarea.setSelectionRange(newPos, newPos);
  textarea.focus();

  closeMathEquationModal();
  renderMarkdown();
  scheduleSave();
}

function setupMathEquationEventListeners() {
  const btnBlock = document.getElementById('math-mode-block');
  const btnInline = document.getElementById('math-mode-inline');
  const input = document.getElementById('math-equation-input');
  const btnClose = document.getElementById('btn-close-math-modal');
  const btnInsert = document.getElementById('btn-insert-math-equation');
  const modal = document.getElementById('math-equation-modal');

  btnBlock?.addEventListener('click', () => {
    currentMathMode = 'block';
    updateMathModeUI();
    updateMathEquationPreview();
  });

  btnInline?.addEventListener('click', () => {
    currentMathMode = 'inline';
    updateMathModeUI();
    updateMathEquationPreview();
  });

  input?.addEventListener('input', updateMathEquationPreview);

  // Chips de plantillas rápidas
  document.querySelectorAll('.math-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const snippet = chip.getAttribute('data-insert');
      if (!snippet || !input) return;

      const s = input.selectionStart;
      const e = input.selectionEnd;
      const val = input.value;
      input.value = val.substring(0, s) + snippet + val.substring(e);
      const newPos = s + snippet.length;
      input.focus();
      input.setSelectionRange(newPos, newPos);
      updateMathEquationPreview();
    });
  });

  btnClose?.addEventListener('click', closeMathEquationModal);
  btnInsert?.addEventListener('click', insertMathEquationIntoEditor);

  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeMathEquationModal();
  });

  // Atajo Enter con Ctrl/Cmd para insertar rápido
  input?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      insertMathEquationIntoEditor();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMathEquationModal();
    }
  });
}

// ==========================================
// 16. RENDERIZADO Y ASISTENTE DE DIAGRAMAS (MERMAID JS)
// ==========================================
const DIAGRAM_TEMPLATES = {
  flowchart: `flowchart TD
    Inicio([Inicio]) --> Validar{¿Datos válidos?}
    Validar -->|Sí| Procesar[Procesar Registro]
    Validar -->|No| Corregir[Mostrar Errores]
    Corregir --> Formulario[Reintentar]
    Formulario --> Validar
    Procesar --> Guardar[(Base de Datos SQLite)]
    Guardar --> Fin([Operación Completada])`,

  brainstorm: `flowchart TD
    %% Lluvia de Ideas / Brainstorming (Mapa de Clústeres)
    Reto(["💡 <b>RETO O PREGUNTA CENTRAL</b><br/><i>¿Cómo podemos impulsar nuestro proyecto al siguiente nivel?</i>"]):::centro

    %% Clústeres de Ideación
    Reto --- C1["⚡ <b>Quick Wins</b><br/>(Bajo esfuerzo, alto impacto)"]:::quick
    Reto --- C2["🚀 <b>Ideas Disruptivas</b><br/>(Innovación y diferenciación)"]:::disruptiva
    Reto --- C3["🎨 <b>Experiencia de Usuario</b><br/>(Diseño, empatía y valor)"]:::ux
    Reto --- C4["⚙️ <b>Eficacia y Tecnología</b><br/>(Escalabilidad y arquitectura)"]:::tecnica

    %% Ideas Generadas por Clúster
    C1 --- I1["• Automatizar tareas repetitivas<br/>• Plantillas preconstruidas listas<br/>• Atajos de teclado intuitivos"]:::idea
    C2 --- I2["• Asistente proactivo con Inteligencia Artificial<br/>• Sinapsis visual y conexiones automáticas<br/>• Espacios colaborativos en tiempo real"]:::idea
    C3 --- I3["• Modo zen ultra limpio sin distracciones<br/>• Búsqueda difusa ultrarrápida<br/>• Notificaciones amigables no invasivas"]:::idea
    C4 --- I4["• Base de datos local ultraligera<br/>• Cifrado robusto de extremo a extremo<br/>• Sincronización instantánea offline"]:::idea

    %% Estilos Visuales del Brainstorming
    classDef centro fill:#f59e0b25,stroke:#f59e0b,stroke-width:2.5px,color:#fff,font-weight:bold;
    classDef quick fill:#10b98125,stroke:#10b981,stroke-width:2px,color:#fff,font-weight:bold;
    classDef disruptiva fill:#8b5cf625,stroke:#8b5cf6,stroke-width:2px,color:#fff,font-weight:bold;
    classDef ux fill:#ec489925,stroke:#ec4899,stroke-width:2px,color:#fff,font-weight:bold;
    classDef tecnica fill:#0ea5e925,stroke:#0ea5e9,stroke-width:2px,color:#fff,font-weight:bold;
    classDef idea fill:#1e293b,stroke:#475569,stroke-width:1px,color:#f1f5f9;

    class Reto centro;
    class C1 quick;
    class C2 disruptiva;
    class C3 ux;
    class C4 tecnica;
    class I1,I2,I3,I4 idea;`,

  synoptic: `flowchart LR
    %% Cuadro Sinóptico (Esquema de Llaves)
    Tema["<b>Idea General</b><br/>(Tema Principal)"]

    %% Ideas Principales
    Tema --- P1["<b>Idea Principal 1</b>"]
    Tema --- P2["<b>Idea Principal 2</b>"]
    Tema --- P3["<b>Idea Principal 3</b>"]

    %% Ideas Secundarias y Conceptos (Sub-llaves)
    P1 --- S1_1["Idea Secundaria 1.1"]
    P1 --- S1_2["Idea Secundaria 1.2"]
    S1_1 --- D1_1["• Concepto clave A<br/>• Ejemplo representativo"]
    S1_2 --- D1_2["• Concepto clave B"]

    P2 --- S2_1["Idea Secundaria 2.1"]
    P2 --- S2_2["Idea Secundaria 2.2"]
    S2_1 --- D2_1["• Concepto clave C"]
    S2_2 --- D2_2["• Concepto clave D"]

    P3 --- S3_1["Idea Secundaria 3.1"]
    S3_1 --- D3_1["• Concepto clave E"]

    %% Estilos de Cuadro Sinóptico
    classDef tema fill:#0284c7,stroke:#38bdf8,stroke-width:2px,color:#ffffff,font-weight:bold;
    classDef principal fill:#4f46e5,stroke:#818cf8,stroke-width:2px,color:#ffffff,font-weight:bold;
    classDef secundaria fill:#1e293b,stroke:#0ea5e9,stroke-width:1.5px,color:#f8fafc;
    classDef detalle fill:#0f172a,stroke:#475569,stroke-width:1px,color:#cbd5e1;

    class Tema tema;
    class P1,P2,P3 principal;
    class S1_1,S1_2,S2_1,S2_2,S3_1 secundaria;
    class D1_1,D1_2,D2_1,D2_2,D3_1 detalle;`,

  foda: `flowchart TB
    %% ==========================================
    %% MATRIZ FODA ESTRATÉGICA - PLANO CARTESIANO 2X2
    %% ==========================================
    subgraph PLANO["<b>🎯 MATRIZ FODA: PLANO CARTESIANO DE DECISIÓN ESTRATÉGICA</b>"]
        direction TB

        %% Indicador Superior del Eje Y
        EJE_Y_POS["<b>▲ (+Y) FACTORES FAVORABLES / POSITIVOS (CRECIMIENTO)</b>"]:::ejeYPos

        subgraph FILA_SUPERIOR[" "]
            direction LR

            %% Cuadrante I: Interno + Positivo (Fortalezas)
            subgraph C_FO["<b>💪 CUADRANTE I: FORTALEZAS (INTERNAS)</b>"]
                direction TB
                F1["⭐ <b>Ventaja Competitiva Única:</b><br/>Tecnología propietaria y propiedad intelectual.<br/>🏷️ <i>[Tecnología] • Impacto: Alto</i>"]:::itemF
                F2["⭐ <b>Talento & Cultura:</b><br/>Equipo senior altamente capacitado y ágil.<br/>🏷️ <i>[Equipo] • Impacto: Alto</i>"]:::itemF
                F3["⭐ <b>Eficiencia Operativa:</b><br/>Costos de infraestructura mínimos y optimizados.<br/>🏷️ <i>[Finanzas] • Impacto: Medio</i>"]:::itemF
                F_ESTRATEGIA["🚀 <b>Estrategia FO (Maxi-Maxi):</b><br/><i>Acelerar expansión usando ventajas propias.</i>"]:::badgeFO
            end

            %% Cuadrante II: Externo + Positivo (Oportunidades)
            subgraph C_OP["<b>🚀 CUADRANTE II: OPORTUNIDADES (EXTERNAS)</b>"]
                direction TB
                O1["⭐ <b>Demanda Insatisfecha:</b><br/>Crecimiento anual del 35% en el mercado objetivo.<br/>🏷️ <i>[Mercado] • Potencial: Máximo</i>"]:::itemO
                O2["⭐ <b>Alianzas Estratégicas:</b><br/>Posibilidad de sinergias con líderes de industria.<br/>🏷️ <i>[Alianzas] • Potencial: Alto</i>"]:::itemO
                O3["⭐ <b>Adopción Tecnológica:</b><br/>Transición masiva de clientes a soluciones modernas.<br/>🏷️ <i>[Tendencia] • Potencial: Alto</i>"]:::itemO
                O_ESTRATEGIA["💡 <b>Estrategia DO (Mini-Maxi):</b><br/><i>Superar brechas para capturar nuevas olas.</i>"]:::badgeDO
            end
        end

        %% Intersección de Ejes Cartesianos (Eje X: Interno vs Externo)
        EJE_X_DIV["<b>◀ (-X) FACTORES INTERNOS  ◄───  [ 🎯 ORIGEN (0,0) ]  ───►  FACTORES EXTERNOS (+X) ▶</b>"]:::ejeX

        subgraph FILA_INFERIOR[" "]
            direction LR

            %% Cuadrante III: Interno + Negativo (Debilidades)
            subgraph C_DE["<b>⚠️ CUADRANTE III: DEBILIDADES (INTERNAS)</b>"]
                direction TB
                D1["⚡ <b>Presupuesto Limitado:</b><br/>Flujo de caja ajustado para marketing masivo.<br/>🏷️ <i>[Capital] • Prioridad: Urgente</i>"]:::itemD
                D2["⚡ <b>Poca Presencia de Marca:</b><br/>Reconocimiento incipiente frente a incumbentes.<br/>🏷️ <i>[Branding] • Prioridad: Alta</i>"]:::itemD
                D3["⚡ <b>Procesos No Estandarizados:</b><br/>Dependencia de conocimiento tácito de fundadores.<br/>🏷️ <i>[Operaciones] • Prioridad: Media</i>"]:::itemD
                D_ESTRATEGIA["🛡️ <b>Estrategia FA (Maxi-Mini):</b><br/><i>Blindarse con fortalezas ante vientos en contra.</i>"]:::badgeFA
            end

            %% Cuadrante IV: Externo + Negativo (Amenazas)
            subgraph C_AM["<b>🛡️ CUADRANTE IV: AMENAZAS (EXTERNAS)</b>"]
                direction TB
                A1["⚡ <b>Competencia Agresiva:</b><br/>Entrada de gigantes tecnológicos con precios cero.<br/>🏷️ <i>[Riesgo] • Severidad: Crítica</i>"]:::itemA
                A2["⚡ <b>Volatilidad Regulatoria:</b><br/>Nuevas normativas de privacidad y cumplimiento.<br/>🏷️ <i>[Legal] • Severidad: Alta</i>"]:::itemA
                A3["⚡ <b>Incertidumbre Macroeconómica:</b><br/>Contracción de inversión en software empresarial.<br/>🏷️ <i>[Economía] • Severidad: Media</i>"]:::itemA
                A_ESTRATEGIA["⚠️ <b>Estrategia DA (Mini-Mini):</b><br/><i>Plan de contingencia y reducción de flancos débiles.</i>"]:::badgeDA
            end
        end

        %% Indicador Inferior del Eje Y
        EJE_Y_NEG["<b>▼ (-Y) FACTORES DESFAVORABLES / NEGATIVOS (RIESGOS)</b>"]:::ejeYNeg
    end

    EJE_Y_POS ~~~ FILA_SUPERIOR ~~~ EJE_X_DIV ~~~ FILA_INFERIOR ~~~ EJE_Y_NEG

    %% ==========================================
    %% ESTILOS VISUALES Y PALETA CROMÁTICA
    %% ==========================================
    classDef ejeYPos fill:#064e3b33,stroke:#10b981,stroke-width:2px,color:#a7f3d0,font-weight:bold;
    classDef ejeYNeg fill:#7f1d1d33,stroke:#ef4444,stroke-width:2px,color:#fecaca,font-weight:bold;
    classDef ejeX fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#e0f2fe,font-weight:bold;

    %% Cuadrantes y Tarjetas
    classDef itemF fill:#022c22,stroke:#10b981,stroke-width:1.5px,color:#ecfdf5;
    classDef itemO fill:#083344,stroke:#06b6d4,stroke-width:1.5px,color:#ecfeff;
    classDef itemD fill:#451a03,stroke:#f59e0b,stroke-width:1.5px,color:#fffbeb;
    classDef itemA fill:#4c0519,stroke:#f43f5e,stroke-width:1.5px,color:#fff1f2;

    %% Insignias Estratégicas (Fórmula de Acción)
    classDef badgeFO fill:#065f46,stroke:#34d399,stroke-width:2px,color:#ffffff,font-weight:bold;
    classDef badgeDO fill:#155e75,stroke:#22d3ee,stroke-width:2px,color:#ffffff,font-weight:bold;
    classDef badgeFA fill:#92400e,stroke:#fbbf24,stroke-width:2px,color:#ffffff,font-weight:bold;
    classDef badgeDA fill:#9f1239,stroke:#fb7185,stroke-width:2px,color:#ffffff,font-weight:bold;

    class F1,F2,F3 itemF;
    class O1,O2,O3 itemO;
    class D1,D2,D3 itemD;
    class A1,A2,A3,A4 itemA;
    class F_ESTRATEGIA badgeFO;
    class O_ESTRATEGIA badgeDO;
    class D_ESTRATEGIA badgeFA;
    class A_ESTRATEGIA badgeDA;`,

  comparison: `flowchart TB
    %% Cuadro Comparativo de Alto Rendimiento
    subgraph HEADER["<b>⚖️ MATRIZ DE COMPARACIÓN TÉCNICA Y ESTRATÉGICA</b>"]
        direction TB

        subgraph COL_A["<b>🔵 OPCIÓN A: KORTEXA (Local-First)</b>"]
            direction TB
            A_RESUMEN["<b>Enfoque:</b> Privacidad y Segundo Cerebro Autónomo<br/><b>Evaluación:</b> ⭐⭐⭐⭐⭐ (Excelente)"]:::badgeA
            A1["🏛️ <b>Arquitectura & Datos:</b><br/>Markdown (.md) estándar + Base SQLite local<br/><i>Sin formatos cerrados ni ataduras</i><br/>✅ <b>Control Absoluto</b>"]:::optA
            A2["🔒 <b>Privacidad & Seguridad:</b><br/>Cifrado PBKDF2 local + Bóvedas aisladas<br/><i>Tus datos nunca salen de tu máquina</i><br/>✅ <b>100% Privado</b>"]:::optA
            A3["⚡ <b>Rendimiento & Latencia:</b><br/>Respuesta en milisegundos (latencia 0)<br/><i>Opera perfectamente 100% sin conexión</i><br/>✅ <b>Offline Nativo</b>"]:::optA
            A4["💰 <b>Modelo de Costos:</b><br/>Auto-alojado, código abierto y libre<br/><i>Sin cuotas mensuales ni cobro por usuario</i><br/>✅ <b>Costo Cero</b>"]:::optA
            A5["🎯 <b>Caso de Uso Ideal:</b><br/>Investigadores, desarrolladores y personas<br/>que valoran privacidad total y rapidez"]:::optA
        end

        subgraph COL_B["<b>🟣 OPCIÓN B: NOTION / SAAS (Nube Propietaria)</b>"]
            direction TB
            B_RESUMEN["<b>Enfoque:</b> Colaboración Centralizada en la Nube<br/><b>Evaluación:</b> ⭐⭐⭐⭐☆ (Bueno)"]:::badgeB
            B1["🏛️ <b>Arquitectura & Datos:</b><br/>Base de datos propietaria en servidores remotos<br/><i>Exportación compleja / Vendor Lock-in</i><br/>⚠️ <b>Formato Propietario</b>"]:::optB
            B2["🔒 <b>Privacidad & Seguridad:</b><br/>Almacenado en la nube corporativa de terceros<br/><i>Sujeto a políticas y accesos de terceros</i><br/>⚠️ <b>Privacidad Compartida</b>"]:::optB
            B3["⚡ <b>Rendimiento & Latencia:</b><br/>Carga variable según conexión y servidores<br/><i>Inutilizable si se cae internet o el servicio</i><br/>⚠️ <b>Requiere Conexión</b>"]:::optB
            B4["💰 <b>Modelo de Costos:</b><br/>Suscripción periódica recurrente ($10-$20/mes)<br/><i>Escala de costo con cada nuevo usuario</i><br/>⚠️ <b>Pago Recurrente</b>"]:::optB
            B5["🎯 <b>Caso de Uso Ideal:</b><br/>Equipos corporativos remotos que necesitan<br/>comentarios y edición simultánea masiva"]:::optB
        end
    end

    COL_A ~~~ COL_B

    %% Estilos de Alto Impacto Visual
    classDef badgeA fill:#0369a1,stroke:#38bdf8,stroke-width:2px,color:#ffffff,font-weight:bold;
    classDef badgeB fill:#6b21a8,stroke:#c084fc,stroke-width:2px,color:#ffffff,font-weight:bold;
    classDef optA fill:#082f49,stroke:#0ea5e9,stroke-width:1.5px,color:#f0f9ff;
    classDef optB fill:#2e1065,stroke:#a855f7,stroke-width:1.5px,color:#faf5ff;

    class A_RESUMEN badgeA;
    class B_RESUMEN badgeB;
    class A1,A2,A3,A4,A5 optA;
    class B1,B2,B3,B4,B5 optB;`,

  er: `erDiagram
    USUARIO ||--o{ BOVEDA : posee
    USUARIO ||--o{ NOTA : crea
    BOVEDA ||--o{ NOTA : contiene
    NOTA ||--o{ ETIQUETA : categoriza

    USUARIO {
        int id PK
        string username
        string email
        string password_hash
    }
    BOVEDA {
        int id PK
        int user_id FK
        string nombre
        boolean encrypted
    }
    NOTA {
        int id PK
        int boveda_id FK
        string titulo
        text contenido
        datetime updated_at
    }`,

  class: `classDiagram
    class CerebroKortexa {
        +String usuario
        +List~Boveda~ bovedas
        +crearNota(titulo, contenido)
        +buscarSinapsis(query)
    }
    class Boveda {
        +String nombre
        +Boolean cifrada
        +bloquear()
        +desbloquear(password)
    }
    class Nota {
        +String titulo
        +String contenido
        +List~String~ wikilinks
        +renderizarGrafo()
    }
    CerebroKortexa "1" *-- "many" Boveda
    Boveda "1" *-- "many" Nota`,

  sequence: `sequenceDiagram
    autonumber
    actor Usuario
    participant Frontend as Kortexa Web
    participant Server as Servidor Node
    participant DB as SQLite DB

    Usuario->>Frontend: Ingresa credenciales (user, pass)
    Frontend->>Server: POST /api/auth/login
    Server->>DB: Consulta usuario y verification hash
    DB-->>Server: Retorna registro
    Server->>Server: Valida contraseña con PBKDF2
    Server-->>Frontend: Token de Sesión (Cookie segura)
    Frontend-->>Usuario: Redirige a Bóvedas Privadas`,

  state: `stateDiagram-v2
    [*] --> Bloqueada
    Bloqueada --> Verificando : Ingresa Contraseña Maestra
    Verificando --> Desbloqueada : Contraseña Válida
    Verificando --> Bloqueada : Contraseña Incorrecta
    Desbloqueada --> Editando : Selecciona Nota
    Editando --> Guardando : Modifica Contenido
    Guardando --> Desbloqueada : Auto-guardado OK (600ms)
    Desbloqueada --> Bloqueada : Bloquear Bóveda (Ctrl+L)`,

  mindmap: `mindmap
  root((Segundo Cerebro))
    Capturar
      Pensamientos Rápidos
      Notas de Voz
      Imágenes y Tablas
    Organizar
      Bóvedas Aisladas
      Carpetas Jerárquicas
      Búsqueda Rápida
    Conectar
      Wikilinks Sinápticos
      Red Neuronal 2D
      Grafo de Conocimiento
    Sintetizar
      Diagramas UML y ER
      Ecuaciones KaTeX
      Hojas de Cálculo`,

  gantt: `gantt
    title Cronograma de Implementación Kortexa
    dateFormat YYYY-MM-DD
    section Backend
        Sistema Auth SQLite       :done,    2026-11-01, 2026-11-04
        HTTPS & Certificados SSL   :done,    2026-11-05, 2026-11-07
        Aislamiento de Bóvedas    :done,    2026-11-08, 2026-11-09
    section Frontend
        Selects Personalizados    :done,    2026-11-09, 2026-11-09
        Ecuaciones KaTeX          :done,    2026-11-09, 2026-11-09
        Diagramas Mermaid         :active,  2026-11-09, 2026-11-10`
};

let currentDiagramType = 'flowchart';
let diagramPreviewDebounceTimer = null;

async function renderMermaidDiagramsInPreview() {
  const containers = markdownPreviewEl?.querySelectorAll('.mermaid');
  if (!containers || containers.length === 0 || !window.mermaid) return;

  const isDark = (document.documentElement.getAttribute('data-resolved-theme') || 'dark') === 'dark';
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      securityLevel: 'loose',
      fontFamily: 'Plus Jakarta Sans, sans-serif'
    });
  } catch (e) {}

  for (let i = 0; i < containers.length; i++) {
    const el = containers[i];
    if (el.getAttribute('data-processed') === 'true') continue;
    const rawCode = el.getAttribute('data-code') ? decodeURIComponent(el.getAttribute('data-code')) : el.textContent;
    const uniqueId = `mermaid-render-${Date.now()}-${i}`;
    try {
      const { svg } = await window.mermaid.render(uniqueId, rawCode);
      el.innerHTML = svg;
      el.setAttribute('data-processed', 'true');

      const wrapper = el.closest('.mermaid-wrapper');
      if (wrapper && !wrapper.dataset.controlsBound) {
        wrapper.dataset.controlsBound = 'true';
        setupDiagramInlineControls(wrapper, el);
      }
    } catch (err) {
      console.warn('Error renderizando diagrama Mermaid:', err);
      el.innerHTML = `<div class="mermaid-error-box">⚠️ Error en la sintaxis del diagrama:\n${escapeHtml(err.message || String(err))}</div>`;
      el.setAttribute('data-processed', 'true');
    }
  }
}

function openDiagramModal(initialCode = '') {
  const modal = document.getElementById('diagram-modal');
  const input = document.getElementById('diagram-code-input');
  if (!modal || !input) return;

  let cleaned = (initialCode || '').trim();
  if (cleaned.startsWith('```mermaid')) {
    cleaned = cleaned.replace(/^```mermaid\s*/i, '').replace(/```$/i, '').trim();
  }

  if (cleaned) {
    input.value = cleaned;
    if (/brainstorm|lluvia\s*de\s*ideas/i.test(cleaned)) currentDiagramType = 'brainstorm';
    else if (/cuadro\s*sin[oó]ptico/i.test(cleaned)) currentDiagramType = 'synoptic';
    else if (/foda|dafo|swot/i.test(cleaned)) currentDiagramType = 'foda';
    else if (/comparati|comparativo/i.test(cleaned)) currentDiagramType = 'comparison';
    else if (cleaned.startsWith('erDiagram')) currentDiagramType = 'er';
    else if (cleaned.startsWith('classDiagram')) currentDiagramType = 'class';
    else if (cleaned.startsWith('sequenceDiagram')) currentDiagramType = 'sequence';
    else if (cleaned.startsWith('stateDiagram')) currentDiagramType = 'state';
    else if (cleaned.startsWith('mindmap')) currentDiagramType = 'mindmap';
    else if (cleaned.startsWith('gantt')) currentDiagramType = 'gantt';
    else currentDiagramType = 'flowchart';
  } else {
    currentDiagramType = 'flowchart';
    input.value = DIAGRAM_TEMPLATES.flowchart;
  }

  updateDiagramTypePills();
  scheduleDiagramPreviewUpdate(true);

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => input.focus(), 60);
}

function closeDiagramModal() {
  const modal = document.getElementById('diagram-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
  }
  markdownInputEl?.focus();
}

function updateDiagramTypePills() {
  document.querySelectorAll('#diagram-types-nav .diagram-type-pill').forEach(pill => {
    pill.classList.toggle('active', pill.getAttribute('data-type') === currentDiagramType);
  });
}

function scheduleDiagramPreviewUpdate(immediate = false) {
  clearTimeout(diagramPreviewDebounceTimer);
  if (immediate) {
    updateDiagramLivePreview();
  } else {
    diagramPreviewDebounceTimer = setTimeout(updateDiagramLivePreview, 350);
  }
}

async function updateDiagramLivePreview() {
  const input = document.getElementById('diagram-code-input');
  const preview = document.getElementById('diagram-live-preview');
  if (!input || !preview) return;

  const code = input.value.trim();
  if (!code) {
    preview.innerHTML = '<span class="diagram-preview-placeholder">Escribe código Mermaid para ver el diagrama...</span>';
    return;
  }

  if (window.mermaid) {
    const isDark = (document.documentElement.getAttribute('data-resolved-theme') || 'dark') === 'dark';
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? 'dark' : 'default',
        securityLevel: 'loose',
        fontFamily: 'Plus Jakarta Sans, sans-serif'
      });
      const uniqueId = `mermaid-modal-preview-${Date.now()}`;
      const { svg } = await window.mermaid.render(uniqueId, code);
      preview.innerHTML = svg;
    } catch (err) {
      preview.innerHTML = `<div class="mermaid-error-box">⚠️ Sintaxis incompleta o error:\n${escapeHtml(err.message || String(err))}</div>`;
    }
  } else {
    preview.innerHTML = `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

function insertDiagramIntoEditor() {
  const input = document.getElementById('diagram-code-input');
  if (!input || !markdownInputEl) return;

  const code = input.value.trim();
  if (!code) {
    closeDiagramModal();
    return;
  }

  const snippet = `\n\`\`\`mermaid\n${code}\n\`\`\`\n`;

  const textarea = markdownInputEl;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const fullText = textarea.value;

  textarea.value = fullText.substring(0, start) + snippet + fullText.substring(end);
  const newPos = start + snippet.length;
  textarea.setSelectionRange(newPos, newPos);
  textarea.focus();

  closeDiagramModal();
  renderMarkdown();
  scheduleSave();
}

function setupDiagramEventListeners() {
  const input = document.getElementById('diagram-code-input');
  const btnClose = document.getElementById('btn-close-diagram-modal');
  const btnInsert = document.getElementById('btn-insert-diagram');
  const modal = document.getElementById('diagram-modal');

  document.querySelectorAll('#diagram-types-nav .diagram-type-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const type = pill.getAttribute('data-type');
      if (type && DIAGRAM_TEMPLATES[type]) {
        currentDiagramType = type;
        updateDiagramTypePills();
        if (input) {
          input.value = DIAGRAM_TEMPLATES[type];
          scheduleDiagramPreviewUpdate(true);
        }
      }
    });
  });

  input?.addEventListener('input', () => scheduleDiagramPreviewUpdate(false));

  btnClose?.addEventListener('click', closeDiagramModal);
  btnInsert?.addEventListener('click', insertDiagramIntoEditor);

  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeDiagramModal();
  });

  input?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      insertDiagramIntoEditor();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeDiagramModal();
    }
  });
}

function setupDiagramInlineControls(wrapper, diagramEl) {
  let scale = 1.0;
  const viewport = wrapper.querySelector('.mermaid-viewport');

  const btnZoomIn = wrapper.querySelector('.btn-diagram-zoom-in');
  const btnZoomOut = wrapper.querySelector('.btn-diagram-zoom-out');
  const btnReset = wrapper.querySelector('.btn-diagram-zoom-reset');
  const btnFullscreen = wrapper.querySelector('.btn-diagram-fullscreen');

  function applyZoom(newScale) {
    scale = Math.max(0.3, Math.min(3.0, newScale));
    if (viewport) {
      viewport.style.transform = scale === 1.0 ? '' : `scale(${scale})`;
    }
  }

  btnZoomIn?.addEventListener('click', (e) => {
    e.stopPropagation();
    applyZoom(scale + 0.2);
  });

  btnZoomOut?.addEventListener('click', (e) => {
    e.stopPropagation();
    applyZoom(scale - 0.2);
  });

  btnReset?.addEventListener('click', (e) => {
    e.stopPropagation();
    applyZoom(1.0);
  });

  btnFullscreen?.addEventListener('click', (e) => {
    e.stopPropagation();
    const svgEl = diagramEl.querySelector('svg');
    if (svgEl) {
      openDiagramFullscreenModal(svgEl.outerHTML);
    }
  });

  diagramEl?.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const svgEl = diagramEl.querySelector('svg');
    if (svgEl) {
      openDiagramFullscreenModal(svgEl.outerHTML);
    }
  });
}

// ==========================================
// VISOR DE DIAGRAMAS EN PANTALLA COMPLETA (PAN & ZOOM)
// ==========================================
let fsDiagramState = {
  scale: 1.0,
  panX: 0,
  panY: 0,
  isDragging: false,
  startX: 0,
  startY: 0
};

function openDiagramFullscreenModal(svgHtml) {
  const modal = document.getElementById('diagram-fullscreen-modal');
  const content = document.getElementById('diagram-fullscreen-content');
  if (!modal || !content) return;

  content.innerHTML = svgHtml;
  fsDiagramState = {
    scale: 1.0,
    panX: 0,
    panY: 0,
    isDragging: false,
    startX: 0,
    startY: 0
  };

  updateFullscreenDiagramTransform();

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
}

function closeDiagramFullscreenModal() {
  const modal = document.getElementById('diagram-fullscreen-modal');
  const content = document.getElementById('diagram-fullscreen-content');
  if (modal) {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
  }
  if (content) {
    content.innerHTML = '';
  }
}

function updateFullscreenDiagramTransform() {
  const content = document.getElementById('diagram-fullscreen-content');
  const zoomLevelEl = document.getElementById('diagram-fs-zoom-level');
  if (!content) return;

  content.style.transform = `translate(${fsDiagramState.panX}px, ${fsDiagramState.panY}px) scale(${fsDiagramState.scale})`;
  if (zoomLevelEl) {
    zoomLevelEl.textContent = `${Math.round(fsDiagramState.scale * 100)}%`;
  }
}

function setupDiagramFullscreenEventListeners() {
  const canvas = document.getElementById('diagram-fullscreen-canvas');
  const modal = document.getElementById('diagram-fullscreen-modal');
  const btnClose = document.getElementById('btn-fs-diagram-close');
  const btnZoomIn = document.getElementById('btn-fs-diagram-zoom-in');
  const btnZoomOut = document.getElementById('btn-fs-diagram-zoom-out');
  const btnReset = document.getElementById('btn-fs-diagram-reset');

  if (!canvas || !modal) return;

  btnClose?.addEventListener('click', closeDiagramFullscreenModal);

  // Zoom con botones
  btnZoomIn?.addEventListener('click', (e) => {
    e.stopPropagation();
    fsDiagramState.scale = Math.min(5.0, fsDiagramState.scale * 1.25);
    updateFullscreenDiagramTransform();
  });

  btnZoomOut?.addEventListener('click', (e) => {
    e.stopPropagation();
    fsDiagramState.scale = Math.max(0.2, fsDiagramState.scale / 1.25);
    updateFullscreenDiagramTransform();
  });

  btnReset?.addEventListener('click', (e) => {
    e.stopPropagation();
    fsDiagramState.scale = 1.0;
    fsDiagramState.panX = 0;
    fsDiagramState.panY = 0;
    updateFullscreenDiagramTransform();
  });

  // Zoom interactivo con la rueda del ratón
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
    const newScale = Math.max(0.2, Math.min(5.0, fsDiagramState.scale * zoomFactor));

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - (rect.width / 2);
    const mouseY = e.clientY - rect.top - (rect.height / 2);

    fsDiagramState.panX -= (mouseX - fsDiagramState.panX) * (zoomFactor - 1);
    fsDiagramState.panY -= (mouseY - fsDiagramState.panY) * (zoomFactor - 1);
    fsDiagramState.scale = newScale;

    updateFullscreenDiagramTransform();
  }, { passive: false });

  // Pan y Arrastre con el ratón
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    fsDiagramState.isDragging = true;
    fsDiagramState.startX = e.clientX - fsDiagramState.panX;
    fsDiagramState.startY = e.clientY - fsDiagramState.panY;
    canvas.classList.add('grabbing');
  });

  window.addEventListener('mousemove', (e) => {
    if (!fsDiagramState.isDragging) return;
    fsDiagramState.panX = e.clientX - fsDiagramState.startX;
    fsDiagramState.panY = e.clientY - fsDiagramState.startY;
    updateFullscreenDiagramTransform();
  });

  window.addEventListener('mouseup', () => {
    if (fsDiagramState.isDragging) {
      fsDiagramState.isDragging = false;
      canvas.classList.remove('grabbing');
    }
  });

  // Salir con tecla Escape
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) {
      closeDiagramFullscreenModal();
    }
  });
}

// ==========================================
// KORTEXA SHARE — SISTEMA PARA COMPARTIR (FASE 1)
// ==========================================

let shareModalCurrentResource = null;
let shareModalSelectedTargetUser = null;
let shareUserSearchDebounce = null;
const openSharedFoldersState = new Set();
const openSharedUserGroupsState = new Set();
let allSharedWithMeItems = [];

// Devuelve el icono SVG semántico según el tipo de archivo compartido
function getSharedFileIconSvg(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><rect x="2" y="4" width="15" height="16" rx="2"/><polygon points="23 7 17 12 23 17 23 7"/></svg>';
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  }
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ec4899" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  }
  if (['pdf'].includes(ext)) {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15h6"/><path d="M9 11h6"/></svg>';
  }
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}

function toggleSharedDrawer(open) {
  const drawer = document.getElementById('shared-with-me-sidebar');
  const btnTrigger = document.getElementById('btn-toggle-shared-drawer');
  if (!drawer) return;

  if (open) {
    toggleChatWidget(false);
  }

  drawer.style.display = open ? 'flex' : 'none';
  if (btnTrigger) btnTrigger.classList.toggle('active', open);

  if (open) {
    loadSharedWithMe();
  }

  window.dispatchEvent(new Event('resize'));
  setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
}

function renderSharedUserGroups(itemsToRender) {
  const container = document.getElementById('shared-drawer-users-container');
  if (!container) return;

  if (!itemsToRender || itemsToRender.length === 0) {
    container.innerHTML = `
      <div style="padding: 36px 16px; text-align: center; color: var(--text-muted); font-size: 12.5px;">
        <div style="font-size: 32px; margin-bottom: 10px;">📂</div>
        <p style="margin: 0; font-weight: 700; color: var(--text-main);">No hay recursos compartidos</p>
        <p style="margin: 6px 0 0; font-size: 11.5px; opacity: 0.75; line-height: 1.4;">Cuando otros usuarios de Kortexa te compartan archivos o carpetas, aparecerán aquí agrupados.</p>
      </div>
    `;
    return;
  }

  // Agrupar por propietario
  const userGroups = {};
  itemsToRender.forEach(item => {
    const ownerId = item.owner.id;
    if (!userGroups[ownerId]) {
      userGroups[ownerId] = {
        owner: item.owner,
        items: []
      };
    }
    userGroups[ownerId].items.push(item);
  });

  container.innerHTML = '';

  Object.values(userGroups).forEach(group => {
    const { owner, items } = group;
    const isOnline = isUserOnline(owner.id) || !!owner.is_online;
    if (isOnline) state.onlineUsers.add(owner.id);

    // Expandir por defecto si está en estado abierto o si es la primera carga
    const isExpanded = openSharedUserGroupsState.has(owner.id) || openSharedUserGroupsState.size === 0;
    if (isExpanded) openSharedUserGroupsState.add(owner.id);

    const card = document.createElement('div');
    card.className = 'shared-user-group-card';
    card.dataset.userId = owner.id;

    const initial = (owner.username || 'U').charAt(0).toUpperCase();
    const countLabel = items.length === 1 ? '1 recurso' : `${items.length} recursos`;

    card.innerHTML = `
      <div class="shared-user-group-header ${isExpanded ? 'open' : ''}">
        <div class="shared-user-meta-left">
          <div class="shared-user-avatar">
            ${initial}
            <span class="user-presence-dot ${isOnline ? 'online' : ''}" data-user-presence-id="${owner.id}" title="${isOnline ? 'En línea' : 'Desconectado'}"></span>
          </div>
          <div class="shared-user-names">
            <span class="shared-user-displayname">${escapeHtml(owner.nombre_completo || owner.username)}</span>
            <span class="shared-user-handle">@${escapeHtml(owner.username)}</span>
          </div>
        </div>
        <div class="shared-user-meta-right">
          <span class="shared-user-count-pill">${countLabel}</span>
          <svg class="shared-user-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>
      <div class="shared-user-accordion-content" style="display: ${isExpanded ? 'block' : 'none'};">
        <div class="shared-user-items-list"></div>
      </div>
    `;

    const headerEl = card.querySelector('.shared-user-group-header');
    const contentEl = card.querySelector('.shared-user-accordion-content');
    const itemsListEl = card.querySelector('.shared-user-items-list');

    headerEl.addEventListener('click', () => {
      const currentlyOpen = contentEl.style.display !== 'none';
      contentEl.style.display = currentlyOpen ? 'none' : 'block';
      headerEl.classList.toggle('open', !currentlyOpen);
      if (currentlyOpen) {
        openSharedUserGroupsState.delete(owner.id);
      } else {
        openSharedUserGroupsState.add(owner.id);
      }
    });

    items.forEach(item => {
      const isWrite = item.permission === 'write';
      const permIcon = isWrite ? '✍️' : '👁️';
      const permTitle = isWrite ? 'Puede editar' : 'Solo lectura';

      if (item.resource_type === 'folder') {
        const folderWrapper = document.createElement('div');
        folderWrapper.className = 'shared-folder-item';
        folderWrapper.dataset.shareId = item.id;

        const isFolderOpen = openSharedFoldersState.has(item.id);

        folderWrapper.innerHTML = `
          <div class="shared-resource-row ${isFolderOpen ? 'open' : ''}" style="margin-bottom: 2px;">
            <div class="shared-resource-left">
              <svg class="shared-folder-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform: ${isFolderOpen ? 'rotate(90deg)' : 'rotate(0deg)'}; transition: transform 0.15s ease; flex-shrink: 0;">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" style="flex-shrink: 0;">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              <span class="shared-resource-title" title="${escapeHtml(item.resource_title)}">${escapeHtml(item.resource_title)}</span>
            </div>
            <span class="shared-resource-perm-tag" title="${permTitle}">${permIcon}</span>
          </div>
          <ul class="shared-folder-sublist" style="display: ${isFolderOpen ? 'block' : 'none'}; list-style: none; padding-left: 18px; margin: 2px 0 6px 0;"></ul>
        `;

        const folderRow = folderWrapper.querySelector('.shared-resource-row');
        const sublistEl = folderWrapper.querySelector('.shared-folder-sublist');

        folderRow.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleSharedFolder(item, folderWrapper, folderRow, sublistEl);
        });

        if (isFolderOpen) {
          fetchAndRenderSharedFolderFiles(item, sublistEl);
        }

        itemsListEl.appendChild(folderWrapper);
      } else {
        const fileRow = document.createElement('div');
        fileRow.className = 'shared-resource-row shared-note-item';
        fileRow.dataset.shareId = item.id;

        const iconSvg = getSharedFileIconSvg(item.resource_path || item.resource_title);

        fileRow.innerHTML = `
          <div class="shared-resource-left" title="${escapeHtml(item.resource_title)}">
            ${iconSvg}
            <span class="shared-resource-title">${escapeHtml(item.resource_title)}</span>
          </div>
          <span class="shared-resource-perm-tag" title="${permTitle}">${permIcon}</span>
        `;

        fileRow.addEventListener('click', () => {
          openSharedNote(item);
        });

        itemsListEl.appendChild(fileRow);
      }
    });

    container.appendChild(card);
  });
}

async function loadSharedWithMe() {
  const countBadge = document.getElementById('shared-count-badge');
  const totalBadge = document.getElementById('shared-sidebar-total-badge');
  const leftContainer = document.getElementById('shared-with-me-container');

  try {
    const res = await fetch('/api/shares/shared-with-me');
    if (!res.ok) return;
    const data = await res.json();
    allSharedWithMeItems = data.items || [];

    if (countBadge) countBadge.textContent = allSharedWithMeItems.length;
    if (totalBadge) {
      totalBadge.textContent = allSharedWithMeItems.length;
      totalBadge.style.display = allSharedWithMeItems.length > 0 ? 'inline-block' : 'none';
    }

    if (leftContainer) {
      leftContainer.style.display = 'block';
    }

    const filterInput = document.getElementById('shared-drawer-filter-input');
    const query = filterInput ? filterInput.value.trim().toLowerCase() : '';
    const filtered = query
      ? allSharedWithMeItems.filter(item =>
          (item.resource_title || '').toLowerCase().includes(query) ||
          (item.resource_path || '').toLowerCase().includes(query) ||
          (item.owner?.username || '').toLowerCase().includes(query) ||
          (item.owner?.nombre_completo || '').toLowerCase().includes(query)
        )
      : allSharedWithMeItems;

    renderSharedUserGroups(filtered);
  } catch (err) {
    console.error('Error al cargar recursos compartidos conmigo:', err);
  }
}

async function toggleSharedFolder(item, wrapper, header, sublist) {
  const isCurrentlyOpen = openSharedFoldersState.has(item.id);
  const chevron = header.querySelector('.shared-folder-chevron');

  if (isCurrentlyOpen) {
    openSharedFoldersState.delete(item.id);
    header.classList.remove('open');
    sublist.style.display = 'none';
    if (chevron) chevron.style.transform = 'rotate(0deg)';
  } else {
    openSharedFoldersState.add(item.id);
    header.classList.add('open');
    sublist.style.display = 'block';
    if (chevron) chevron.style.transform = 'rotate(90deg)';
    await fetchAndRenderSharedFolderFiles(item, sublist);
  }
}

async function fetchAndRenderSharedFolderFiles(item, sublist) {
  try {
    sublist.innerHTML = '<li style="padding: 4px 8px; font-size: 11px; color: var(--text-muted);">Cargando archivos...</li>';
    const res = await fetch(`/api/shared-folders/tree?share_id=${item.id}`);
    if (!res.ok) {
      sublist.innerHTML = '<li style="padding: 4px 8px; font-size: 11px; color: var(--danger);">No se pudo cargar el contenido</li>';
      return;
    }
    const data = await res.json();
    const files = data.files || [];

    if (files.length === 0) {
      sublist.innerHTML = '<li style="padding: 4px 8px; font-size: 11px; color: var(--text-muted); font-style: italic;">Carpeta vacía</li>';
      return;
    }

    sublist.innerHTML = '';
    files.forEach(f => {
      const subLi = document.createElement('li');
      subLi.className = 'shared-folder-subitem';
      subLi.dataset.shareId = item.id;
      subLi.dataset.filename = f.filename;

      subLi.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0; color: #a5b4fc;">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span class="shared-subitem-title" title="${escapeHtml(f.title || f.filename)}">${escapeHtml(f.title || f.filename)}</span>
      `;

      subLi.addEventListener('click', (e) => {
        e.stopPropagation();
        openSharedFolderFile(item, f);
      });

      sublist.appendChild(subLi);
    });
  } catch (err) {
    console.error('Error al obtener archivos de carpeta compartida:', err);
    sublist.innerHTML = '<li style="padding: 4px 8px; font-size: 11px; color: var(--danger);">Error de conexión</li>';
  }
}

async function openSharedFolderFile(folderShare, file, providedPassword = null) {
  try {
    const headers = {};
    if (providedPassword) headers['x-vault-password'] = providedPassword;

    const res = await fetch(`/api/shared-notes/read?share_id=${folderShare.id}&sub_path=${encodeURIComponent(file.filename)}`, { headers });
    if (!res.ok) {
      const err = await res.json();
      if (res.status === 423 || err.locked) {
        const pwd = await showPromptModal({
          title: 'Bóveda Compartida Cifrada (AES-256)',
          message: `El archivo "${file.title || file.filename}" pertenece a una bóveda cifrada de @${folderShare.owner?.username || 'propietario'}.\nIngrese la contraseña de la bóveda para descifrarlo:`,
          placeholder: 'Contraseña de la bóveda...',
          defaultValue: '',
          confirmText: 'Desbloquear y Abrir',
          cancelText: 'Cancelar'
        });
        if (!pwd) return;
        return openSharedFolderFile(folderShare, file, pwd);
      }
      showToast(err.error || 'No se pudo abrir el archivo', 'danger');
      return;
    }
    const data = await res.json();
    const isMedia = data.file_type && data.file_type !== 'note';

    state.activeNote = {
      isSharedWithMe: true,
      shareId: folderShare.id,
      subPath: file.filename,
      title: data.title || file.title || file.filename,
      name: file.filename,
      filename: `${folderShare.resource_title}/${file.filename}`,
      folder: `${folderShare.resource_title} (@${folderShare.owner.username})`,
      permission: folderShare.permission,
      content: data.content || '',
      type: data.file_type || (data.resource_type === 'file' ? 'note' : data.resource_type),
      ext: data.ext,
      size: data.size || 0,
      url: data.url
    };

    titleInputEl.value = data.title;
    titleInputEl.readOnly = isMedia || folderShare.permission !== 'write';
    noteFolderName.textContent = `${folderShare.resource_title} (@${folderShare.owner.username})`;

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
        markdownToolbarEl.style.display = (folderShare.permission === 'write' && !(editorWorkspaceEl && editorWorkspaceEl.classList.contains('preview-mode'))) ? 'flex' : 'none';
      }
      markdownInputEl.value = data.content || '';
      markdownInputEl.readOnly = folderShare.permission !== 'write';
      renderMarkdown();
      setSaveStatus(folderShare.permission === 'write' ? 'Guardado' : 'Solo Lectura');
    }

    // Cambiar a vista de editor si estábamos en grafo
    const viewEditor = document.getElementById('view-editor');
    const viewGraph = document.getElementById('view-graph');
    const navEditor = document.getElementById('nav-editor');
    const navGraph = document.getElementById('nav-graph');
    if (viewEditor && viewGraph) {
      viewEditor.classList.add('active');
      viewGraph.classList.remove('active');
      navEditor?.classList.add('active');
      navGraph?.classList.remove('active');
      state.activeTab = 'editor';
    }

    // Resaltar en lista de compartidos
    document.querySelectorAll('.shared-folder-subitem').forEach(el => {
      const match = el.dataset.shareId === String(folderShare.id) && el.dataset.filename === file.filename;
      el.classList.toggle('active', match);
    });
    document.querySelectorAll('.shared-note-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));

    showToast(`Archivo "${file.title || file.filename}" abierto (${folderShare.permission === 'write' ? 'Edición permitida' : 'Solo lectura'})`, 'info');
  } catch (err) {
    showToast('Error al abrir archivo de la carpeta compartida', 'danger');
  }
}

async function openSharedNote(item, providedPassword = null) {
  try {
    const headers = {};
    if (providedPassword) headers['x-vault-password'] = providedPassword;

    const res = await fetch(`/api/shared-notes/read?share_id=${item.id}`, { headers });
    if (!res.ok) {
      const err = await res.json();
      if (res.status === 423 || err.locked) {
        const pwd = await showPromptModal({
          title: 'Recurso Cifrado (AES-256)',
          message: `La nota "${item.resource_title || 'Nota'}" pertenece a una bóveda cifrada de @${item.owner?.username || 'propietario'}.\nIngrese la contraseña de la bóveda para descifrarla:`,
          placeholder: 'Contraseña de la bóveda...',
          defaultValue: '',
          confirmText: 'Desbloquear y Abrir',
          cancelText: 'Cancelar'
        });
        if (!pwd) return;
        return openSharedNote(item, pwd);
      }
      showToast(err.error || 'No se pudo abrir el recurso compartido', 'danger');
      return;
    }
    const data = await res.json();
    const isMedia = data.file_type && data.file_type !== 'note';

    state.activeNote = {
      isSharedWithMe: true,
      shareId: data.shareId,
      subPath: '',
      title: data.title,
      name: data.filename,
      filename: data.filename,
      folder: `Compartido por @${data.owner.username}`,
      permission: data.permission,
      content: data.content || '',
      type: data.file_type || (data.resource_type === 'file' ? 'note' : data.resource_type),
      ext: data.ext,
      size: data.size || 0,
      url: data.url
    };

    titleInputEl.value = data.title;
    titleInputEl.readOnly = isMedia || data.permission !== 'write';
    noteFolderName.textContent = `Compartido por @${data.owner.username}`;

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
        markdownToolbarEl.style.display = (data.permission === 'write' && !(editorWorkspaceEl && editorWorkspaceEl.classList.contains('preview-mode'))) ? 'flex' : 'none';
      }
      markdownInputEl.value = data.content || '';
      markdownInputEl.readOnly = data.permission !== 'write';
      renderMarkdown();
      setSaveStatus(data.permission === 'write' ? 'Guardado' : 'Solo Lectura');
    }

    // Cambiar a vista de editor si estábamos en grafo
    const viewEditor = document.getElementById('view-editor');
    const viewGraph = document.getElementById('view-graph');
    const navEditor = document.getElementById('nav-editor');
    const navGraph = document.getElementById('nav-graph');
    if (viewEditor && viewGraph) {
      viewEditor.classList.add('active');
      viewGraph.classList.remove('active');
      navEditor?.classList.add('active');
      navGraph?.classList.remove('active');
      state.activeTab = 'editor';
    }

    // Resaltar en lista de compartidos
    document.querySelectorAll('.shared-note-item').forEach(el => {
      el.classList.toggle('active', el.dataset.shareId === String(item.id));
    });
    document.querySelectorAll('.shared-folder-subitem').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));

    showToast(`Nota compartida abierta (${data.permission === 'write' ? 'Edición permitida' : 'Solo lectura'})`, 'info');
  } catch (err) {
    showToast('Error al abrir la nota compartida', 'danger');
  }
}

function setupSharedDrawerEventListeners() {
  const btnTrigger = document.getElementById('btn-toggle-shared-drawer');
  const btnClose = document.getElementById('btn-close-shared-sidebar');
  const filterInput = document.getElementById('shared-drawer-filter-input');

  btnTrigger?.addEventListener('click', () => {
    const drawer = document.getElementById('shared-with-me-sidebar');
    const isOpen = drawer && drawer.style.display !== 'none';
    toggleSharedDrawer(!isOpen);
  });

  btnClose?.addEventListener('click', () => {
    toggleSharedDrawer(false);
  });

  filterInput?.addEventListener('input', (e) => {
    const query = e.target.value.trim().toLowerCase();
    const filtered = query
      ? allSharedWithMeItems.filter(item =>
          (item.resource_title || '').toLowerCase().includes(query) ||
          (item.resource_path || '').toLowerCase().includes(query) ||
          (item.owner?.username || '').toLowerCase().includes(query) ||
          (item.owner?.nombre_completo || '').toLowerCase().includes(query)
        )
      : allSharedWithMeItems;
    renderSharedUserGroups(filtered);
  });
}

function setupShareModalEventListeners() {
  const btnShare = document.getElementById('btn-share-note');
  const modal = document.getElementById('share-modal');
  const btnClose = document.getElementById('btn-close-share-modal');
  const btnCloseFooter = document.getElementById('btn-close-share-modal-footer');
  const tabBtnPublic = document.getElementById('share-tab-btn-public');
  const tabBtnUsers = document.getElementById('share-tab-btn-users');
  const panelPublic = document.getElementById('share-panel-public');
  const panelUsers = document.getElementById('share-panel-users');
  
  const togglePublic = document.getElementById('toggle-public-link');
  const publicLinkDetails = document.getElementById('public-link-details');
  const shareUrlInput = document.getElementById('share-url-input');
  const btnCopyUrl = document.getElementById('btn-copy-share-url');
  const copyUrlText = document.getElementById('copy-share-url-text');
  
  const chkPassword = document.getElementById('chk-share-password');
  const passwordField = document.getElementById('share-password-field');
  const inputPassword = document.getElementById('input-share-password');
  
  const chkExpiry = document.getElementById('chk-share-expiry');
  const expiryField = document.getElementById('share-expiry-field');
  const inputExpiry = document.getElementById('input-share-expiry');
  const btnSavePublicSettings = document.getElementById('btn-save-public-settings');
  let shareModalHasExistingPassword = false;

  const userSearchInput = document.getElementById('share-user-search-input');
  const usersDropdown = document.getElementById('share-users-dropdown');
  const permissionSelect = document.getElementById('share-user-permission-select');
  const btnAddUserShare = document.getElementById('btn-add-user-share');
  const membersList = document.getElementById('share-members-list');
  const usersCountBadge = document.getElementById('share-users-count');

  if (!modal) return;

  function openShareModalForResource(customResource) {
    if (!customResource) {
      if (!state.activeNote || !state.activeNote.filename) {
        showToast('Abre o crea una nota primero para poder compartirla', 'warning');
        return;
      }
      if (state.activeNote.isSharedWithMe) {
        showToast('Este recurso fue compartido contigo. Solo el propietario puede administrar los accesos.', 'info');
        return;
      }
      customResource = {
        path: state.activeNote.filename,
        title: state.activeNote.title || state.activeNote.name || 'Documento',
        type: state.activeNote.type || 'file'
      };
    }

    shareModalCurrentResource = customResource;

    const modalTitleEl = document.getElementById('share-modal-title');
    const modalSubtitleEl = document.getElementById('share-modal-subtitle');

    if (customResource.type === 'vault') {
      modalTitleEl.textContent = `Compartir Bóveda: ${customResource.title}`;
      modalSubtitleEl.textContent = 'Acceso a toda la bóveda (todos los archivos y subcarpetas)';
    } else if (customResource.type === 'folder') {
      modalTitleEl.textContent = `Compartir Carpeta: ${customResource.title}`;
      modalSubtitleEl.textContent = `Carpeta: ${customResource.path}`;
    } else {
      modalTitleEl.textContent = `Compartir: ${customResource.title}`;
      modalSubtitleEl.textContent = `Archivo: ${customResource.path}`;
    }

    // Resetear formulario de usuario
    shareModalSelectedTargetUser = null;
    if (userSearchInput) userSearchInput.value = '';
    if (btnAddUserShare) btnAddUserShare.disabled = true;
    if (usersDropdown) {
      usersDropdown.style.display = 'none';
      usersDropdown.innerHTML = '';
    }

    // Resetear a pestaña inicial (Enlace Público)
    tabBtnPublic?.classList.add('active');
    tabBtnUsers?.classList.remove('active');
    panelPublic?.classList.add('active');
    panelUsers?.classList.remove('active');
    if (panelPublic) panelPublic.style.display = 'flex';
    if (panelUsers) panelUsers.style.display = 'none';

    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');

    loadResourceShares();
  }

  // Exponer globalmente
  window.openShareModalForResource = openShareModalForResource;

  function closeShareModal() {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    shareModalCurrentResource = null;
    shareModalSelectedTargetUser = null;
  }

  btnShare?.addEventListener('click', () => openShareModalForResource());
  btnClose?.addEventListener('click', closeShareModal);
  btnCloseFooter?.addEventListener('click', closeShareModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeShareModal();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) {
      closeShareModal();
    }
  });

  // Cambio de pestañas
  tabBtnPublic?.addEventListener('click', () => {
    tabBtnPublic.classList.add('active');
    tabBtnUsers.classList.remove('active');
    panelPublic?.classList.add('active');
    panelUsers?.classList.remove('active');
    if (panelPublic) panelPublic.style.display = 'flex';
    if (panelUsers) panelUsers.style.display = 'none';
  });

  tabBtnUsers?.addEventListener('click', () => {
    tabBtnUsers.classList.add('active');
    tabBtnPublic.classList.remove('active');
    panelUsers?.classList.add('active');
    panelPublic?.classList.remove('active');
    if (panelUsers) panelUsers.style.display = 'flex';
    if (panelPublic) panelPublic.style.display = 'none';
  });

  // Cargar estado actual de compartición
  async function loadResourceShares() {
    if (!shareModalCurrentResource) return;
    try {
      const res = await fetch(`/api/shares/resource?path=${encodeURIComponent(shareModalCurrentResource.path)}`);
      if (!res.ok) return;
      const data = await res.json();

      // 1. Enlace público
      if (data.publicShare) {
        togglePublic.checked = true;
        publicLinkDetails.style.display = 'block';
        const fullUrl = `${window.location.origin}/s/${data.publicShare.share_token}`;
        shareUrlInput.value = fullUrl;

        shareModalHasExistingPassword = Boolean(data.publicShare.has_password);
        chkPassword.checked = shareModalHasExistingPassword;
        passwordField.style.display = shareModalHasExistingPassword ? 'block' : 'none';
        inputPassword.value = '';
        if (shareModalHasExistingPassword) {
          inputPassword.placeholder = '•••••••• (Escribe para cambiar la clave)';
        } else {
          inputPassword.placeholder = 'Escribe una contraseña para el enlace...';
        }

        chkExpiry.checked = Boolean(data.publicShare.expires_at);
        expiryField.style.display = data.publicShare.expires_at ? 'block' : 'none';
        if (data.publicShare.expires_at) {
          inputExpiry.value = data.publicShare.expires_at.split('T')[0];
        } else {
          inputExpiry.value = '';
        }
      } else {
        togglePublic.checked = false;
        publicLinkDetails.style.display = 'none';
        shareUrlInput.value = '';
        shareModalHasExistingPassword = false;
        chkPassword.checked = false;
        passwordField.style.display = 'none';
        inputPassword.value = '';
        inputPassword.placeholder = 'Escribe una contraseña para el enlace...';
        chkExpiry.checked = false;
        expiryField.style.display = 'none';
        inputExpiry.value = '';
      }

      // 2. Usuarios compartidos
      renderUserSharesList(data.userShares || []);
    } catch (err) {
      console.error('Error al cargar datos de recurso compartido:', err);
    }
  }

  // Toggle enlace público
  togglePublic?.addEventListener('change', async () => {
    if (!shareModalCurrentResource) return;
    const enable = togglePublic.checked;

    try {
      const res = await fetch('/api/shares/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enable,
          path: shareModalCurrentResource.path,
          title: shareModalCurrentResource.title,
          resource_type: shareModalCurrentResource.type
        })
      });
      const data = await res.json();
      if (data.enabled) {
        publicLinkDetails.style.display = 'block';
        shareUrlInput.value = `${window.location.origin}/s/${data.share_token}`;
        showToast('Enlace público generado y activado', 'success');
      } else {
        publicLinkDetails.style.display = 'none';
        shareUrlInput.value = '';
        showToast('Enlace público desactivado', 'info');
      }
    } catch (err) {
      showToast('Error al modificar enlace público', 'danger');
      togglePublic.checked = !enable;
    }
  });

  // Copiar URL pública
  btnCopyUrl?.addEventListener('click', () => {
    if (!shareUrlInput.value) return;
    navigator.clipboard.writeText(shareUrlInput.value).then(() => {
      copyUrlText.textContent = '¡Copiado!';
      setTimeout(() => copyUrlText.textContent = 'Copiar', 2000);
      showToast('Enlace copiado al portapapeles', 'info');
    });
  });

  // Checkbox contraseña
  chkPassword?.addEventListener('change', () => {
    passwordField.style.display = chkPassword.checked ? 'block' : 'none';
    if (!chkPassword.checked) {
      inputPassword.value = '';
    } else {
      setTimeout(() => inputPassword?.focus(), 50);
    }
  });

  // Toggle visibilidad contraseña
  const btnToggleSharePwd = document.getElementById('btn-toggle-share-pwd-visibility');
  btnToggleSharePwd?.addEventListener('click', () => {
    if (!inputPassword) return;
    const isPwd = inputPassword.type === 'password';
    inputPassword.type = isPwd ? 'text' : 'password';
    const eyeIcon = document.getElementById('icon-share-pwd-eye');
    if (eyeIcon) {
      eyeIcon.innerHTML = isPwd
        ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    }
  });

  // Checkbox expiración
  chkExpiry?.addEventListener('change', () => {
    expiryField.style.display = chkExpiry.checked ? 'block' : 'none';
    if (!chkExpiry.checked) inputExpiry.value = '';
    else setTimeout(() => inputExpiry?.focus(), 50);
  });

  // Guardar opciones de contraseña / expiración para enlace público
  btnSavePublicSettings?.addEventListener('click', async () => {
    if (!shareModalCurrentResource) return;

    // VALIDACIÓN 1: CONTRASEÑA CONTRA VACÍOS Y LONGITUD MÍNIMA
    let pwdPayload = undefined;
    if (chkPassword.checked) {
      const rawPwd = inputPassword.value.trim();
      if (!rawPwd) {
        if (!shareModalHasExistingPassword) {
          showToast('Por favor, ingresa una contraseña para proteger el enlace.', 'warning');
          inputPassword.focus();
          return;
        }
        // Si ya tenía contraseña previa y no escribió una nueva, la conserva intacta
        pwdPayload = undefined;
      } else {
        if (rawPwd.length < 3) {
          showToast('La contraseña del enlace debe tener al menos 3 caracteres.', 'warning');
          inputPassword.focus();
          return;
        }
        pwdPayload = rawPwd;
      }
    } else {
      // Toggle apagado -> eliminar protección de contraseña
      pwdPayload = null;
    }

    // VALIDACIÓN 2: FECHA DE EXPIRACIÓN CONTRA VACÍOS Y FECHAS EN EL PASADO
    let expPayload = null;
    if (chkExpiry.checked) {
      const rawExp = inputExpiry.value;
      if (!rawExp) {
        showToast('Por favor, selecciona una fecha de expiración para el enlace.', 'warning');
        inputExpiry.focus();
        return;
      }
      const expDate = new Date(rawExp + 'T23:59:59');
      const now = new Date();
      if (expDate < now) {
        showToast('La fecha de expiración debe ser una fecha futura.', 'warning');
        inputExpiry.focus();
        return;
      }
      expPayload = rawExp;
    } else {
      // Toggle apagado -> sin expiración
      expPayload = null;
    }

    const saveBtnText = document.getElementById('btn-save-public-settings-text');
    const originalText = saveBtnText ? saveBtnText.textContent : 'Guardar Opciones de Enlace';
    if (saveBtnText) saveBtnText.textContent = 'Guardando...';
    btnSavePublicSettings.disabled = true;

    try {
      const bodyPayload = {
        enable: true,
        path: shareModalCurrentResource.path,
        title: shareModalCurrentResource.title,
        resource_type: shareModalCurrentResource.type,
        expires_at: expPayload
      };
      if (pwdPayload !== undefined) {
        bodyPayload.password = pwdPayload;
      }

      const res = await fetch('/api/shares/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (pwdPayload !== undefined) {
          shareModalHasExistingPassword = Boolean(pwdPayload);
          if (shareModalHasExistingPassword) {
            inputPassword.placeholder = '•••••••• (Escribe para cambiar la clave)';
            inputPassword.value = '';
          }
        }
        if (saveBtnText) saveBtnText.textContent = '¡Opciones Guardadas!';
        btnSavePublicSettings.classList.add('saved');
        showToast('Opciones de seguridad del enlace guardadas', 'success');
        setTimeout(() => {
          if (saveBtnText) saveBtnText.textContent = originalText;
          btnSavePublicSettings.classList.remove('saved');
          btnSavePublicSettings.disabled = false;
        }, 2200);
      } else {
        if (saveBtnText) saveBtnText.textContent = originalText;
        btnSavePublicSettings.disabled = false;
        showToast(data.error || 'Error al guardar opciones del enlace', 'danger');
      }
    } catch {
      if (saveBtnText) saveBtnText.textContent = originalText;
      btnSavePublicSettings.disabled = false;
      showToast('Error al guardar opciones del enlace', 'danger');
    }
  });

  // Búsqueda de usuarios
  userSearchInput?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    clearTimeout(shareUserSearchDebounce);
    shareModalSelectedTargetUser = null;
    btnAddUserShare.disabled = true;

    if (!val) {
      usersDropdown.style.display = 'none';
      usersDropdown.innerHTML = '';
      return;
    }

    shareUserSearchDebounce = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(val)}`);
        if (!res.ok) return;
        const data = await res.json();
        const users = data.users || [];

        if (users.length === 0) {
          usersDropdown.innerHTML = '<div style="padding: 10px; font-size: 12px; color: var(--text-muted); text-align: center;">No se encontraron usuarios</div>';
          usersDropdown.style.display = 'block';
          return;
        }

        usersDropdown.innerHTML = '';
        users.forEach(u => {
          const isOnline = isUserOnline(u.id) || !!u.is_online;
          if (isOnline) state.onlineUsers.add(u.id);

          const item = document.createElement('div');
          item.className = 'share-user-option';
          item.innerHTML = `
            <div class="share-user-avatar-wrap">
              <div class="share-user-avatar">${(u.username || 'U')[0].toUpperCase()}</div>
              <span class="user-presence-dot avatar-badge ${isOnline ? 'online' : ''}" data-user-presence-id="${u.id}" title="${isOnline ? 'En línea' : 'Desconectado'}"></span>
            </div>
            <div class="share-user-details">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span class="share-user-fullname">${escapeHtml(u.nombre_completo || u.username)}</span>
                <span class="presence-badge ${isOnline ? 'online' : ''}" data-user-presence-text-id="${u.id}">${isOnline ? 'En línea' : 'Desconectado'}</span>
              </div>
              <span class="share-user-handle">@${escapeHtml(u.username)} • ${escapeHtml(u.email)}</span>
            </div>
          `;
          item.addEventListener('click', () => {
            shareModalSelectedTargetUser = u;
            userSearchInput.value = `@${u.username} (${u.nombre_completo || u.username})`;
            usersDropdown.style.display = 'none';
            btnAddUserShare.disabled = false;
          });
          usersDropdown.appendChild(item);
        });

        usersDropdown.style.display = 'block';
      } catch (err) {
        console.error('Error buscando usuarios:', err);
      }
    }, 200);
  });

  // Cerrar dropdown si se hace clic fuera
  document.addEventListener('click', (e) => {
    if (!usersDropdown.contains(e.target) && e.target !== userSearchInput) {
      usersDropdown.style.display = 'none';
    }
  });

  // Compartir con usuario
  btnAddUserShare?.addEventListener('click', async () => {
    if (!shareModalCurrentResource || !shareModalSelectedTargetUser) return;
    const perm = permissionSelect.value || 'read';

    try {
      const res = await fetch('/api/shares/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: shareModalCurrentResource.path,
          title: shareModalCurrentResource.title,
          resource_type: shareModalCurrentResource.type,
          target_user_id: shareModalSelectedTargetUser.id,
          permission: perm
        })
      });

      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Error al compartir con el usuario', 'danger');
        return;
      }

      showToast(`Compartido con @${shareModalSelectedTargetUser.username}`, 'success');
      userSearchInput.value = '';
      shareModalSelectedTargetUser = null;
      btnAddUserShare.disabled = true;

      renderUserSharesList(data.userShares || []);
    } catch (err) {
      showToast('Error de red al compartir con el usuario', 'danger');
    }
  });

  function renderUserSharesList(shares) {
    if (!membersList) return;
    if (usersCountBadge) {
      usersCountBadge.textContent = shares.length;
      usersCountBadge.style.display = shares.length > 0 ? 'inline-block' : 'none';
    }

    if (shares.length === 0) {
      membersList.innerHTML = '<div style="padding: 12px; font-size: 12.5px; color: var(--text-muted); text-align: center;">Este recurso aún no se ha compartido con ningún usuario.</div>';
      return;
    }

    membersList.innerHTML = '';
    shares.forEach(s => {
      const isOnline = isUserOnline(s.user.id) || !!s.user.is_online;
      if (isOnline) state.onlineUsers.add(s.user.id);

      const row = document.createElement('div');
      row.className = 'share-member-row';

      const isWrite = s.permission === 'write';
      const permLabel = isWrite ? '✍️ Puede editar' : '👁️ Solo lectura';
      const permClass = isWrite ? 'write' : 'read';

      row.innerHTML = `
        <div class="share-member-left">
          <div class="share-user-avatar-wrap">
            <div class="share-user-avatar" style="width: 26px; height: 26px; font-size: 11px;">
              ${(s.user.username || 'U')[0].toUpperCase()}
            </div>
            <span class="user-presence-dot avatar-badge ${isOnline ? 'online' : ''}" data-user-presence-id="${s.user.id}" title="${isOnline ? 'En línea' : 'Desconectado'}"></span>
          </div>
          <div class="share-user-details">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="share-user-fullname" style="font-size: 12.5px;">${escapeHtml(s.user.nombre_completo || s.user.username)}</span>
              <span class="presence-badge ${isOnline ? 'online' : ''}" data-user-presence-text-id="${s.user.id}">${isOnline ? 'En línea' : 'Desconectado'}</span>
            </div>
            <span class="share-user-handle" style="font-size: 10.5px;">@${escapeHtml(s.user.username)}</span>
          </div>
        </div>
        <div class="share-member-right">
          <span class="share-perm-badge ${permClass}">${permLabel}</span>
          <button type="button" class="share-revoke-btn" title="Revocar acceso a este usuario">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      `;

      const revokeBtn = row.querySelector('.share-revoke-btn');
      revokeBtn.addEventListener('click', async () => {
        try {
          const res = await fetch(`/api/shares/${s.id}`, { method: 'DELETE' });
          if (res.ok) {
            showToast(`Acceso revocado a @${s.user.username}`, 'info');
            loadResourceShares();
          }
        } catch {
          showToast('Error al revocar acceso', 'danger');
        }
      });

      membersList.appendChild(row);
    });
  }
}

// ==========================================
// CANAL WEBSOCKET EN TIEMPO REAL (NOTIFICACIONES & SYNC)
// ==========================================
let wsClient = null;
let wsReconnectTimeout = null;
let wsReconnectAttempts = 0;

function playNotificationChime() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12); // A5
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
  } catch {}
}

function updateRealtimeStatus(online) {
  const dot = document.getElementById('realtime-status-dot');
  if (dot) {
    dot.classList.toggle('online', online);
    const perm = ('Notification' in window) ? Notification.permission : 'no-soporte';
    const permText = perm === 'granted' ? ' (Notificaciones de escritorio activas)' : ' (Haz clic para activar notificaciones de escritorio)';
    dot.title = online ? `Canal en tiempo real conectado${permText}` : 'Canal en tiempo real desconectado';
  }
}

function isUserOnline(userId) {
  if (!userId) return false;
  const uid = parseInt(userId, 10);
  return state.onlineUsers instanceof Set && state.onlineUsers.has(uid);
}

function updateAllPresenceIndicators() {
  document.querySelectorAll('[data-user-presence-id]').forEach(el => {
    const uid = parseInt(el.dataset.userPresenceId, 10);
    const isOnline = isUserOnline(uid);
    el.classList.toggle('online', isOnline);
    el.title = isOnline ? 'En línea' : 'Desconectado';
  });
  document.querySelectorAll('[data-user-presence-text-id]').forEach(el => {
    const uid = parseInt(el.dataset.userPresenceTextId, 10);
    const isOnline = isUserOnline(uid);
    el.textContent = isOnline ? 'En línea' : 'Desconectado';
    el.classList.toggle('online', isOnline);
  });
}

// ==========================================
// NOTIFICACIONES DE ESCRITORIO (SISTEMA OPERATIVO)
// ==========================================
async function requestDesktopNotificationPermission(notifyUser = false) {
  if (!('Notification' in window)) return false;

  if (Notification.permission === 'default') {
    try {
      const res = await Notification.requestPermission();
      if (res === 'granted' && notifyUser) {
        showToast('🔔 Notificaciones del sistema operativo activadas para Kortexa', 'success');
      } else if (res === 'denied' && notifyUser) {
        showToast('Notificaciones de escritorio bloqueadas. Permítelas desde el icono del candado en la barra de direcciones.', 'warning', 7000);
      }
      checkChatNotificationBanner();
      updateRealtimeStatus(Boolean(wsClient && wsClient.readyState === WebSocket.OPEN));
      return res === 'granted';
    } catch {
      return false;
    }
  }
  return Notification.permission === 'granted';
}

function showDesktopNotification({ title, body, icon = '/favicon.svg', tag = null, onClick = null }) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  try {
    const notif = new Notification(title, {
      body,
      icon,
      badge: icon,
      silent: false,
      tag: tag || ('kortexa-msg-' + Date.now())
    });

    notif.onclick = () => {
      try {
        window.focus();
      } catch {}
      if (typeof onClick === 'function') {
        onClick();
      }
      notif.close();
    };
  } catch (err) {
    console.warn('Error mostrando notificación nativa del SO:', err);
  }
}

function initWebSocketManager() {
  if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  try {
    wsClient = new WebSocket(wsUrl);

    wsClient.onopen = () => {
      wsReconnectAttempts = 0;
      updateRealtimeStatus(true);
      // Solicitar permiso de notificaciones de escritorio si aún no se ha decidido
      if ('Notification' in window && Notification.permission === 'default') {
        requestDesktopNotificationPermission(false);
      }
    };

    // Permitir clic en el punto indicador para activar o verificar notificaciones
    const dotEl = document.getElementById('realtime-status-dot');
    if (dotEl && !dotEl.dataset.hasClickListener) {
      dotEl.dataset.hasClickListener = 'true';
      dotEl.style.cursor = 'pointer';
      dotEl.addEventListener('click', () => {
        if (!('Notification' in window)) {
          showToast('Tu navegador no soporta notificaciones de escritorio', 'warning');
          return;
        }
        if (Notification.permission === 'default') {
          requestDesktopNotificationPermission(true);
        } else if (Notification.permission === 'granted') {
          showDesktopNotification({
            title: 'Kortexa — Notificaciones Activas',
            body: 'Las notificaciones del sistema operativo están funcionando correctamente.'
          });
          showToast('Notificaciones del sistema operativo activas', 'info');
        } else {
          showToast('Notificaciones bloqueadas en la configuración del navegador', 'warning');
        }
      });
    }

    wsClient.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'CONNECTED' && msg.data && Array.isArray(msg.data.onlineUserIds)) {
          state.onlineUsers = new Set(msg.data.onlineUserIds.map(Number));
          updateAllPresenceIndicators();
        }
        handleRealtimeEvent(msg);
      } catch (err) {
        console.error('Error parseando mensaje WebSocket:', err);
      }
    };

    wsClient.onclose = (e) => {
      updateRealtimeStatus(false);
      // Código 4001: no autenticado
      if (e.code === 4001) return;

      const delay = Math.min(1000 * Math.pow(1.5, wsReconnectAttempts), 15000);
      wsReconnectAttempts++;
      clearTimeout(wsReconnectTimeout);
      wsReconnectTimeout = setTimeout(() => {
        initWebSocketManager();
      }, delay);
    };

    wsClient.onerror = () => {
      updateRealtimeStatus(false);
    };
  } catch (err) {
    console.error('Error al inicializar WebSocket:', err);
  }
}

function handleRealtimeEvent(msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'USER_STATUS_CHANGED': {
      const { userId, online } = msg.data;
      const uid = parseInt(userId, 10);
      if (online) {
        state.onlineUsers.add(uid);
      } else {
        state.onlineUsers.delete(uid);
      }
      updateAllPresenceIndicators();
      break;
    }

    case 'SHARE_RECEIVED': {
      const { title, resource_type, permission, owner } = msg.data;
      playNotificationChime();

      const typeLabel = resource_type === 'vault' ? 'la bóveda' : (resource_type === 'folder' ? 'la carpeta' : 'la nota');
      const permLabel = permission === 'write' ? 'edición' : 'solo lectura';
      
      showToast(`🔔 @${owner.username} te ha compartido ${typeLabel} "${title}" (${permLabel})`, 'info', 6000);

      // Si la ventana está en segundo plano o minimizada, mostrar notificación en la pantalla del SO
      if (document.hidden || !document.hasFocus()) {
        showDesktopNotification({
          title: 'Kortexa — Nuevo Recurso Compartido',
          body: `@${owner.username} te ha compartido ${typeLabel} "${title}" (${permLabel})`,
          onClick: () => {
            loadSharedWithMe();
            if (resource_type === 'vault') {
              loadVaultInfo();
            }
          }
        });
      }

      // Refrescar lista de compartidos conmigo en el sidebar
      loadSharedWithMe();

      // Si es una bóveda, refrescar el listado de bóvedas disponibles
      if (resource_type === 'vault') {
        loadVaultInfo();
      }
      break;
    }

    case 'SHARE_REVOKED': {
      const { title, resource_type, owner } = msg.data;
      showToast(`⚠️ Acceso revocado a "${title}" por @${owner.username}`, 'warning', 5000);

      if (document.hidden || !document.hasFocus()) {
        showDesktopNotification({
          title: 'Kortexa — Acceso Revocado',
          body: `@${owner.username} revocó el acceso a "${title}"`,
          onClick: () => {
            loadSharedWithMe();
          }
        });
      }

      loadSharedWithMe();
      if (resource_type === 'vault') {
        loadVaultInfo();
        if (state.isSharedVault) {
          // Si estamos en una bóveda compartida que fue revocada, volver a la bóveda personal
          fetch('/api/vaults')
            .then(r => r.json())
            .then(data => {
              if (data.vaults && data.vaults.length > 0) {
                switchVault(data.vaults[0].name);
              }
            });
        }
      }
      break;
    }

    case 'NOTE_UPDATED': {
      const { title, user } = msg.data;
      showToast(`📝 @${user.username} guardó cambios en "${title}"`, 'info', 3500);

      if (document.hidden || !document.hasFocus()) {
        showDesktopNotification({
          title: 'Kortexa — Nota Actualizada',
          body: `@${user.username} guardó cambios en "${title}"`
        });
      }

      // Si tenemos abierta esa misma nota, actualizar estado
      if (state.activeNote && (state.activeNote.title === title || state.activeNote.filename.endsWith(title + '.md'))) {
        setSaveStatus('Actualizado por colaborador');
      }
      break;
    }

    case 'FRIEND_REQUEST_RECEIVED': {
      const { from_user } = msg.data;
      playNotificationChime();
      showToast(`🔔 @${from_user.username} te ha enviado una solicitud de amistad`, 'info', 6000);
      if (document.hidden || !document.hasFocus()) {
        showDesktopNotification({
          title: 'Kortexa — Solicitud de Amistad',
          body: `@${from_user.username} desea ser tu amigo en Kortexa.`,
          onClick: () => {
            toggleChatWidget(true);
            switchChatTab('requests');
          }
        });
      }
      loadFriendsData();
      break;
    }

    case 'FRIEND_REQUEST_ACCEPTED': {
      const { friend } = msg.data;
      playNotificationChime();
      showToast(`🤝 @${friend.username} y tú ahora son amigos`, 'success', 5000);
      if (document.hidden || !document.hasFocus()) {
        showDesktopNotification({
          title: 'Kortexa — Solicitud Aceptada',
          body: `@${friend.username} aceptó tu solicitud de amistad.`
        });
      }
      loadFriendsData();
      break;
    }

    case 'FRIEND_REMOVED': {
      loadFriendsData();
      if (activeChatFriend && activeChatFriend.id === msg.data.friendId) {
        showToast(`Tu amistad con @${msg.data.username} ha concluido`, 'info');
        closeConversation();
      }
      break;
    }

    case 'CHAT_MESSAGE_RECEIVED': {
      const { message } = msg.data;
      playNotificationChime();

      const widget = document.getElementById('chat-widget');
      const isWidgetVisible = widget && widget.style.display !== 'none';
      const isViewingThisConversation = isWidgetVisible && activeChatFriend && Number(activeChatFriend.id) === Number(message.sender_id);
      const isWindowActive = !document.hidden && document.hasFocus();

      // Si el usuario está viendo activamente este chat en primer plano
      if (isViewingThisConversation && isWindowActive) {
        appendMessageToChat(message);
        fetch(`/api/chat/${message.sender_id}/messages`);
      } else {
        // Si no está en primer plano o no está viendo esta conversación
        if (isViewingThisConversation) {
          appendMessageToChat(message);
        }

        chatUnreadCounts[message.sender_id] = (chatUnreadCounts[message.sender_id] || 0) + 1;
        updateUnreadBadges();
        renderFriendsList();

        if (!document.hidden) {
          showToast(`💬 @${message.sender.username}: "${message.content}"`, 'info', 5000);
        }

        // Mostrar notificación de escritorio en el SO (Windows / Mac)
        showDesktopNotification({
          title: `Kortexa — Mensaje de @${message.sender.username}`,
          body: message.content,
          tag: `kortexa-msg-${message.sender_id}-${Date.now()}`,
          onClick: () => {
            toggleChatWidget(true);
            const friendObj = (chatFriendsData.friends || []).find(f => f.user && f.user.id === message.sender_id)?.user || message.sender;
            openConversationWith(friendObj);
          }
        });
      }
      break;
    }
  }
}

// ==========================================
// MÓDULO DE CHAT & RED DE AMIGOS
// ==========================================
let activeChatFriend = null;
let chatFriendsData = { friends: [], incomingRequests: [], outgoingRequests: [] };
let chatUnreadCounts = {};
let chatAddSearchDebounce = null;

function setupChatWidgetEventListeners() {
  const btnToggle = document.getElementById('btn-toggle-chat-drawer');
  const widget = document.getElementById('chat-widget');
  const btnClose = document.getElementById('btn-close-chat-widget');
  const btnCloseConv = document.getElementById('btn-close-conv');
  const btnBack = document.getElementById('btn-back-to-friends');

  const tabFriends = document.getElementById('chat-tab-friends-btn');
  const tabRequests = document.getElementById('chat-tab-requests-btn');
  const tabAdd = document.getElementById('chat-tab-add-btn');

  const searchAddInput = document.getElementById('chat-add-friend-search');
  const searchAddDropdown = document.getElementById('chat-add-friend-dropdown');

  const chatForm = document.getElementById('chat-message-form');
  const chatInput = document.getElementById('chat-message-input');

  if (!btnToggle || !widget) return;

  btnToggle.addEventListener('click', () => {
    const isVisible = widget.style.display !== 'none';
    toggleChatWidget(!isVisible);
  });

  btnClose?.addEventListener('click', () => toggleChatWidget(false));
  btnCloseConv?.addEventListener('click', () => toggleChatWidget(false));
  btnBack?.addEventListener('click', closeConversation);

  // Cambio de pestañas
  tabFriends?.addEventListener('click', () => switchChatTab('friends'));
  tabRequests?.addEventListener('click', () => switchChatTab('requests'));
  tabAdd?.addEventListener('click', () => switchChatTab('add'));

  // Búsqueda para añadir amigo
  searchAddInput?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    clearTimeout(chatAddSearchDebounce);
    if (!val) {
      searchAddDropdown.style.display = 'none';
      searchAddDropdown.innerHTML = '';
      return;
    }

    chatAddSearchDebounce = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(val)}`);
        if (!res.ok) return;
        const data = await res.json();
        const users = data.users || [];

        searchAddDropdown.innerHTML = '';
        if (users.length === 0) {
          searchAddDropdown.innerHTML = '<div style="padding: 10px; font-size: 11.5px; color: var(--text-muted); text-align: center;">No se encontraron usuarios</div>';
          searchAddDropdown.style.display = 'block';
          return;
        }

        users.forEach(u => {
          const isFriend = chatFriendsData.friends.some(f => f.user.id === u.id);
          const hasRequested = chatFriendsData.outgoingRequests.some(r => r.to_user.id === u.id);

          const item = document.createElement('div');
          item.className = 'chat-friend-row';
          item.innerHTML = `
            <div class="chat-friend-left">
              <div class="share-user-avatar-wrap">
                <div class="share-user-avatar" style="width: 26px; height: 26px; font-size: 11px;">${(u.username || 'U')[0].toUpperCase()}</div>
                <span class="user-presence-dot avatar-badge ${u.is_online ? 'online' : ''}" data-user-presence-id="${u.id}"></span>
              </div>
              <div class="chat-friend-info">
                <div class="chat-friend-fullname">${escapeHtml(u.nombre_completo || u.username)}</div>
                <div class="chat-friend-handle">@${escapeHtml(u.username)}</div>
              </div>
            </div>
            <div class="chat-friend-right">
              ${isFriend 
                ? '<span style="font-size: 10.5px; color: #10b981; font-weight: 600;">Amigo</span>'
                : (hasRequested 
                    ? '<span style="font-size: 10.5px; color: var(--text-muted);">Enviada</span>'
                    : '<button type="button" class="chat-btn-accept" style="padding: 4px 8px; font-size: 11px;">+ Agregar</button>')}
            </div>
          `;

          const addBtn = item.querySelector('.chat-btn-accept');
          addBtn?.addEventListener('click', async (evt) => {
            evt.stopPropagation();
            try {
              const r = await fetch('/api/friends/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_user_id: u.id })
              });
              const resData = await r.json();
              if (r.ok) {
                showToast(`Solicitud enviada a @${u.username}`, 'success');
                searchAddInput.value = '';
                searchAddDropdown.style.display = 'none';
                loadFriendsData();
              } else {
                showToast(resData.error || 'Error al enviar solicitud', 'warning');
              }
            } catch {
              showToast('Error de conexión', 'danger');
            }
          });

          searchAddDropdown.appendChild(item);
        });

        searchAddDropdown.style.display = 'block';
      } catch (err) {
        console.error('Error buscando usuarios para amigos:', err);
      }
    }, 200);
  });

  // Cerrar dropdown si se hace clic fuera
  document.addEventListener('click', (e) => {
    if (!searchAddDropdown?.contains(e.target) && e.target !== searchAddInput) {
      if (searchAddDropdown) searchAddDropdown.style.display = 'none';
    }
  });

  // Botón para habilitar notificaciones nativas del SO
  const btnEnableNotifs = document.getElementById('btn-enable-desktop-notifs');
  btnEnableNotifs?.addEventListener('click', async () => {
    const granted = await requestDesktopNotificationPermission(true);
    checkChatNotificationBanner();
    if (granted) {
      showDesktopNotification({
        title: 'Kortexa — Alertas Activas',
        body: '¡Listo! Recibirás notificaciones en pantalla incluso con la ventana minimizada.'
      });
    }
  });

  // Enviar mensaje
  chatForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!chatInput) return;
    const text = chatInput.value.trim();
    if (!text || !activeChatFriend) return;

    chatInput.value = '';
    await sendChatMessage(text);
  });
}

function checkChatNotificationBanner() {
  const banner = document.getElementById('chat-perm-banner');
  if (!banner) return;
  if ('Notification' in window && Notification.permission === 'default') {
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

function toggleChatWidget(open) {
  const widget = document.getElementById('chat-widget');
  const btnToggle = document.getElementById('btn-toggle-chat-drawer');
  if (!widget) return;
  if (open) {
    toggleSharedDrawer(false);
  }
  widget.style.display = open ? 'flex' : 'none';
  if (btnToggle) btnToggle.classList.toggle('active', open);
  if (open) {
    checkChatNotificationBanner();
    loadFriendsData();
    loadUnreadMessagesSummary();
  } else {
    toggleChatEmojiPicker(false);
  }
  // Disparar evento resize para que editor, grafo y vistas flexibles se adapten suavemente al nuevo ancho
  window.dispatchEvent(new Event('resize'));
  setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
}

function switchChatTab(tabName) {
  const tabFriends = document.getElementById('chat-tab-friends-btn');
  const tabRequests = document.getElementById('chat-tab-requests-btn');
  const tabAdd = document.getElementById('chat-tab-add-btn');

  const panelFriends = document.getElementById('chat-panel-friends');
  const panelRequests = document.getElementById('chat-panel-requests');
  const panelAdd = document.getElementById('chat-panel-add');

  tabFriends?.classList.toggle('active', tabName === 'friends');
  tabRequests?.classList.toggle('active', tabName === 'requests');
  tabAdd?.classList.toggle('active', tabName === 'add');

  if (panelFriends) panelFriends.style.display = tabName === 'friends' ? 'block' : 'none';
  if (panelRequests) panelRequests.style.display = tabName === 'requests' ? 'block' : 'none';
  if (panelAdd) panelAdd.style.display = tabName === 'add' ? 'block' : 'none';
}

async function loadFriendsData() {
  try {
    const res = await fetch('/api/friends');
    if (!res.ok) return;
    chatFriendsData = await res.json();

    // Actualizar badge de solicitudes
    const count = (chatFriendsData.incomingRequests || []).length;
    const badge = document.getElementById('chat-requests-count-badge');
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'inline-block' : 'none';
    }

    renderFriendsList();
    renderIncomingRequests();
  } catch (err) {
    console.error('Error al cargar amigos:', err);
  }
}

function renderFriendsList() {
  const container = document.getElementById('chat-friends-list');
  if (!container) return;

  const friends = chatFriendsData.friends || [];
  if (friends.length === 0) {
    container.innerHTML = `
      <div style="padding: 30px 16px; text-align: center; color: var(--text-muted); font-size: 12.5px;">
        <div style="font-size: 24px; margin-bottom: 6px;">👥</div>
        Aún no tienes amigos agregados.<br>
        Usa la pestaña <strong>➕ Añadir</strong> para buscar amigos.
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  friends.forEach(f => {
    const u = f.user;
    const isOnline = isUserOnline(u.id) || !!u.is_online;
    if (isOnline) state.onlineUsers.add(u.id);
    const unread = chatUnreadCounts[u.id] || 0;

    const row = document.createElement('div');
    row.className = 'chat-friend-row';
    row.innerHTML = `
      <div class="chat-friend-left">
        <div class="share-user-avatar-wrap">
          <div class="share-user-avatar" style="width: 28px; height: 28px; font-size: 11px;">${(u.username || 'U')[0].toUpperCase()}</div>
          <span class="user-presence-dot avatar-badge ${isOnline ? 'online' : ''}" data-user-presence-id="${u.id}" title="${isOnline ? 'En línea' : 'Desconectado'}"></span>
        </div>
        <div class="chat-friend-info">
          <div class="chat-friend-fullname">${escapeHtml(u.nombre_completo || u.username)}</div>
          <div class="chat-friend-handle">@${escapeHtml(u.username)}</div>
        </div>
      </div>
      <div class="chat-friend-right">
        ${unread > 0 ? `<span class="chat-unread-count-pill">${unread}</span>` : ''}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--text-muted);">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </div>
    `;

    row.addEventListener('click', () => {
      openConversationWith(u);
    });

    container.appendChild(row);
  });
}

function renderIncomingRequests() {
  const container = document.getElementById('chat-incoming-requests-list');
  if (!container) return;

  const reqs = chatFriendsData.incomingRequests || [];
  if (reqs.length === 0) {
    container.innerHTML = `
      <div style="padding: 24px 16px; text-align: center; color: var(--text-muted); font-size: 12.5px;">
        No tienes solicitudes pendientes.
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  reqs.forEach(r => {
    const u = r.from_user;
    const item = document.createElement('div');
    item.className = 'chat-request-row';
    item.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <div class="share-user-avatar" style="width: 26px; height: 26px; font-size: 11px;">${(u.username || 'U')[0].toUpperCase()}</div>
        <div>
          <div style="font-size: 12.5px; font-weight: 700; color: var(--text-main);">${escapeHtml(u.nombre_completo || u.username)}</div>
          <div style="font-size: 11px; color: var(--text-muted);">@${escapeHtml(u.username)}</div>
        </div>
      </div>
      <div class="chat-request-actions">
        <button type="button" class="chat-btn-accept" data-req-id="${r.request_id}">Aceptar</button>
        <button type="button" class="chat-btn-reject" data-req-id="${r.request_id}">Rechazar</button>
      </div>
    `;

    item.querySelector('.chat-btn-accept').addEventListener('click', async () => {
      await respondFriendReq(r.request_id, 'accept');
    });
    item.querySelector('.chat-btn-reject').addEventListener('click', async () => {
      await respondFriendReq(r.request_id, 'reject');
    });

    container.appendChild(item);
  });
}

async function respondFriendReq(requestId, action) {
  try {
    const res = await fetch('/api/friends/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, action })
    });
    if (res.ok) {
      showToast(action === 'accept' ? 'Solicitud de amistad aceptada' : 'Solicitud rechazada', 'info');
      loadFriendsData();
    }
  } catch {
    showToast('Error al responder solicitud', 'danger');
  }
}

async function openConversationWith(friendUser) {
  activeChatFriend = friendUser;

  const viewFriends = document.getElementById('chat-view-friends');
  const viewConv = document.getElementById('chat-view-conversation');
  if (viewFriends) viewFriends.style.display = 'none';
  if (viewConv) viewConv.style.display = 'flex';

  // Configurar header
  document.getElementById('conv-friend-name').textContent = friendUser.nombre_completo || friendUser.username;
  document.getElementById('conv-friend-avatar').textContent = (friendUser.username || 'U')[0].toUpperCase();
  
  const isOnline = isUserOnline(friendUser.id);
  const dot = document.getElementById('conv-friend-presence-dot');
  const statusEl = document.getElementById('conv-friend-status');
  if (dot) dot.classList.toggle('online', isOnline);
  if (statusEl) statusEl.textContent = isOnline ? '🟢 En línea' : '⚪ Desconectado';

  // Limpiar no leídos de este usuario
  if (chatUnreadCounts[friendUser.id]) {
    delete chatUnreadCounts[friendUser.id];
    updateUnreadBadges();
  }

  // Cargar mensajes
  const container = document.getElementById('chat-messages-container');
  if (container) container.innerHTML = '<div style="padding: 20px; text-align: center; font-size: 11.5px; color: var(--text-muted);">Cargando mensajes...</div>';

  try {
    const res = await fetch(`/api/chat/${friendUser.id}/messages`);
    if (!res.ok) return;
    const data = await res.json();
    const msgs = data.messages || [];

    if (container) {
      container.innerHTML = '';
      if (msgs.length === 0) {
        container.innerHTML = `
          <div style="padding: 40px 10px; text-align: center; color: var(--text-muted); font-size: 12px;">
            Este es el comienzo de tu conversación con @${escapeHtml(friendUser.username)}.<br>
            ¡Saluda y empieza a colaborar! 👋
          </div>
        `;
      } else {
        msgs.forEach(m => appendMessageToChat(m, false));
        container.scrollTop = container.scrollHeight;
      }
    }

    const input = document.getElementById('chat-message-input');
    input?.focus();
  } catch (err) {
    console.error('Error al cargar mensajes:', err);
  }
}

function closeConversation() {
  activeChatFriend = null;
  toggleChatEmojiPicker(false);
  const viewFriends = document.getElementById('chat-view-friends');
  const viewConv = document.getElementById('chat-view-conversation');
  if (viewFriends) viewFriends.style.display = 'flex';
  if (viewConv) viewConv.style.display = 'none';
  loadFriendsData();
}

async function sendChatMessage(content) {
  if (!activeChatFriend) return;
  try {
    const res = await fetch(`/api/chat/${activeChatFriend.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || 'Error al enviar mensaje', 'warning');
      return;
    }
    const data = await res.json();
    appendMessageToChat(data.message, true);
  } catch {
    showToast('Error al enviar mensaje', 'danger');
  }
}

function appendMessageToChat(msg, autoScroll = true) {
  const container = document.getElementById('chat-messages-container');
  if (!container) return;

  const isMine = msg.sender_id === (state.currentUser?.id || 0);

  const row = document.createElement('div');
  row.className = `chat-msg-row ${isMine ? 'mine' : 'theirs'}`;

  let timeStr = '';
  if (msg.created_at) {
    const d = new Date(msg.created_at);
    timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  row.innerHTML = `
    <div class="chat-bubble ${isMine ? 'mine' : 'theirs'}">${escapeHtml(msg.content)}</div>
    <span class="chat-msg-time">${timeStr}</span>
  `;

  container.appendChild(row);
  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

async function loadUnreadMessagesSummary() {
  try {
    const res = await fetch('/api/chat/unread');
    if (!res.ok) return;
    const data = await res.json();
    chatUnreadCounts = data.bySender || {};
    updateUnreadBadges();
  } catch {}
}

function updateUnreadBadges() {
  let total = 0;
  Object.values(chatUnreadCounts).forEach(c => total += c);

  const badge = document.getElementById('chat-unread-badge');
  if (badge) {
    badge.textContent = total;
    badge.style.display = total > 0 ? 'inline-block' : 'none';
  }
}

// ==========================================
// MÓDULO Y SELECTOR DE EMOJIS (CHAT & EDITOR)
// ==========================================
const EMOJI_CATEGORIES = {
  smileys: {
    name: 'Caras y Emociones',
    icon: '😃',
    emojis: [
      { char: '😀', name: 'sonrisa grin feliz alegre' },
      { char: '😃', name: 'feliz smiley risa alegre' },
      { char: '😄', name: 'sonrisa ojos risa smile contento' },
      { char: '😁', name: 'dientes beam risa mueca' },
      { char: '😆', name: 'carcajada laugh cerrado divertido' },
      { char: '😅', name: 'alivio sudor sweat smile risa' },
      { char: '😂', name: 'llorar de risa joy risa carcajada lol jaja' },
      { char: '🤣', name: 'muerto de risa rofl rodar risa xd' },
      { char: '🥲', name: 'sonrisa lagrima emocionado conmocion' },
      { char: '🥹', name: 'ojos tiernos conmovido pleading ternura' },
      { char: '😊', name: 'sonrojado tierno blush calido' },
      { char: '😇', name: 'angel inocente halo santo bueno' },
      { char: '🙂', name: 'leve sonrisa amable ok' },
      { char: '🙃', name: 'al reves ironia sarcasmo upside' },
      { char: '😉', name: 'guiño complice wink ojo broma' },
      { char: '😌', name: 'aliviado paz calma zen relax' },
      { char: '😍', name: 'enamorado ojos corazon love amor' },
      { char: '🥰', name: 'amor ternura corazones querido' },
      { char: '😘', name: 'beso corazon kiss amor' },
      { char: '😗', name: 'beso silbido' },
      { char: '😚', name: 'beso ojos cerrados ternura' },
      { char: '😋', name: 'delicioso rico yummy sabroso' },
      { char: '😛', name: 'lengua burla chistoso' },
      { char: '😜', name: 'lengua guiño loco broma divertido' },
      { char: '🤪', name: 'loco chiflado zany descontrol' },
      { char: '🤨', name: 'ceja levantada sospecha duda desconfianza' },
      { char: '🧐', name: 'monoculo curioso detective intelectual' },
      { char: '🤓', name: 'nerd inteligente gafas lentes sabio' },
      { char: '😎', name: 'cool gafas de sol estilo pro genial' },
      { char: '🤩', name: 'estrellas emocionado star struck brillante' },
      { char: '🥳', name: 'fiesta celebracion cumple party felicidades' },
      { char: '😏', name: 'sonrisa picara smirk ligue' },
      { char: '😒', name: 'descontento fastidio aburrido me da igual' },
      { char: '😞', name: 'decepcionado triste desilusion' },
      { char: '😔', name: 'pensativo triste desanimado solo' },
      { char: '🥺', name: 'por favor suplica tierno puppy eyes te lo pido' },
      { char: '😢', name: 'llorar lagrima triste cry pena' },
      { char: '😭', name: 'llanto inconsolable triste sob lagrimas' },
      { char: '😤', name: 'furia triunfo orgullo vapor humo' },
      { char: '😠', name: 'enojado molesto angry furia' },
      { char: '😡', name: 'furioso rojo rabia rage odio' },
      { char: '🤬', name: 'insulto censura enojo maldecir bronca' },
      { char: '🤯', name: 'mente explotada shock increible mind blown uau' },
      { char: '😳', name: 'avergonzado sorprendido sonrojado pena' },
      { char: '🥵', name: 'calor caliente sudando verano ardiente' },
      { char: '🥶', name: 'frio congelado temblando invierno' },
      { char: '😱', name: 'grito susto miedo scream panico' },
      { char: '😨', name: 'asustado miedo preocupado temblor' },
      { char: '😰', name: 'ansiedad nervioso sudor frio preocupacion' },
      { char: '😥', name: 'triste aliviado suspiro' },
      { char: '😓', name: 'preocupado cansado sudor trabajo' },
      { char: '🤗', name: 'abrazo cariñoso hug abrazo' },
      { char: '🤔', name: 'pensando duda idea thinking pregunta reflexionar' },
      { char: '🫣', name: 'mirando entre dedos timido curioso asomado' },
      { char: '🤫', name: 'silencio secreto callar shush silencio' },
      { char: '🫡', name: 'saludo respeto militar si señor orden entendido' },
      { char: '🫠', name: 'derritiendose verguenza calor melting me muero' },
      { char: '🤥', name: 'mentira pinocho pinochada liar mentiroso' },
      { char: '😶', name: 'sin palabras callado silencio mudo' },
      { char: '😐', name: 'neutral inexpresivo serio neutro' },
      { char: '😑', name: 'sin comentarios serio aburrido impass' },
      { char: '😬', name: 'mueca incomodo cringe pena ajena' },
      { char: '🫨', name: 'temblando shock sacudida temblor' },
      { char: '😮', name: 'sorpresa boca abierta oh uau' },
      { char: '😯', name: 'asombrado sorpresa uau sorpresa' },
      { char: '😲', name: 'impactado boca abierta increible' },
      { char: '🥱', name: 'bostezo sueño aburrido yawn cansado' },
      { char: '😴', name: 'dormido zzz sueño descansando buenas noches' },
      { char: '🤤', name: 'babeando rico antojo que rico' },
      { char: '😵', name: 'mareado ko desmayado confuso' },
      { char: '🤐', name: 'boca cerrada cremallera secreto mudo silencio' },
      { char: '🥴', name: 'mareado borracho woozy resaca fiesta' },
      { char: '🤢', name: 'nauseas asco enfermo mareo' },
      { char: '🤮', name: 'vomito asco enfermo puaj' },
      { char: '🤧', name: 'estornudo gripe enfermo achis resfriado' },
      { char: '😷', name: 'mascarilla cubrebocas enfermo doctor hospital' },
      { char: '🤒', name: 'termometro fiebre enfermo temperatura' },
      { char: '🤕', name: 'vendado golpe lastimado herido dolor' },
      { char: '🤑', name: 'dinero rico plata billetes cash dolares' },
      { char: '🤠', name: 'vaquero cowboy sombrero oaxaca norte' },
      { char: '😈', name: 'diablillo travieso diablo sonrisa maldad' },
      { char: '👿', name: 'diablo enojado imp maldad demonio' },
      { char: '👻', name: 'fantasma ghost boo susto miedo halloween' },
      { char: '💀', name: 'calavera muerto skull muerto de risa' },
      { char: '☠️', name: 'calavera pirata peligro veneno huesos' },
      { char: '👽', name: 'alien extraterrestre ovni ufo espacio' },
      { char: '🤖', name: 'robot ia bot tecnologico maquina' },
      { char: '💩', name: 'caca poop gracioso popo excremento' },
      { char: '🤡', name: 'payaso clown risa burla circo' }
    ]
  },
  gestures: {
    name: 'Gestos y Personas',
    icon: '👍',
    emojis: [
      { char: '👋', name: 'hola adios saludo mano wave que tal' },
      { char: '🤚', name: 'mano levantada alto stop espera' },
      { char: '✋', name: 'mano abierta 5 cinco parada choca esos cinco' },
      { char: '🖖', name: 'vulcano spock paz saludo prosperidad' },
      { char: '👌', name: 'ok perfecto excelente genial bien de acuerdo' },
      { char: '🤌', name: 'que quieres que dices italiano chef que onda' },
      { char: '🤏', name: 'un poco poquito pequeño small tantito' },
      { char: '✌️', name: 'paz victoria peace dos calma' },
      { char: '🤞', name: 'dedos cruzados suerte ojala crossed esperanza' },
      { char: '🫰', name: 'corazon con dedos dinero kpop finger heart amor' },
      { char: '🤟', name: 'te quiero amor te amo love señas' },
      { char: '🤘', name: 'rock metal fiesta concierto pesado' },
      { char: '🤙', name: 'llamame shaka surfer buena onda que onda' },
      { char: '👈', name: 'señalar izquierda left alla' },
      { char: '👉', name: 'señalar derecha mira alla right' },
      { char: '👆', name: 'señalar arriba up este de arriba' },
      { char: '👇', name: 'señalar abajo mira aqui down este' },
      { char: '☝️', name: 'atencion un momento arriba primero' },
      { char: '🫵', name: 'te señalo a ti tu you eres tu' },
      { char: '👍', name: 'pulgar arriba me gusta bien de acuerdo like va' },
      { char: '👎', name: 'pulgar abajo no me gusta mal dislike nel' },
      { char: '✊', name: 'puño cerrado poder fuerza resistencia' },
      { char: '👊', name: 'choque de puños golpe punch chocalas colega' },
      { char: '🤛', name: 'puño izquierda choque de puños' },
      { char: '🤜', name: 'puño derecha choque de puños' },
      { char: '👏', name: 'aplausos bravo aplaudir felicidades clap ovacion' },
      { char: '🙌', name: 'manos arriba celebracion aleluya hurra viva' },
      { char: '🫶', name: 'corazon con manos amor cariño te amo' },
      { char: '👐', name: 'manos abiertas bienvenida recibir' },
      { char: '🤲', name: 'palmas arriba peticion plegaria recibir' },
      { char: '🤝', name: 'apreton de manos trato acuerdo sociedad socios hecho' },
      { char: '🙏', name: 'por favor gracias rezo oracion bendicion pray porfa' },
      { char: '✍️', name: 'escribir firma nota lapiz redactar apuntar' },
      { char: '💪', name: 'musculo fuerza fuerte poder gym entreno biceps' },
      { char: '👀', name: 'ojos mirando atento pendiente chisme viendo' },
      { char: '👁️', name: 'ojo mirar vision visto mirame' },
      { char: '🧠', name: 'cerebro mente inteligencia idea pensar sesos' },
      { char: '🫂', name: 'abrazo personas afecto compañerismo apoyo' },
      { char: '👤', name: 'silueta usuario persona perfil cuenta' },
      { char: '👥', name: 'usuarios amigos equipo grupo comunidad' }
    ]
  },
  hearts: {
    name: 'Amor y Corazones',
    icon: '❤️',
    emojis: [
      { char: '❤️', name: 'corazon rojo amor te quiero pasion red heart te amo' },
      { char: '🧡', name: 'corazon naranja calidez energia calido' },
      { char: '💛', name: 'corazon amarillo amistad luz sol alegria' },
      { char: '💚', name: 'corazon verde naturaleza esperanza vida salud' },
      { char: '💙', name: 'corazon azul confianza lealtad paz cielo' },
      { char: '💜', name: 'corazon morado purpura magia lujo encanto' },
      { char: '🖤', name: 'corazon negro elegancia luto dark gótico' },
      { char: '🤍', name: 'corazon blanco pureza paz sincero limpio' },
      { char: '🤎', name: 'corazon cafe marron tierra cafe' },
      { char: '💔', name: 'corazon roto desamor tristeza herido broken triste' },
      { char: '❤️‍🔥', name: 'corazon en llamas ardiente pasion amor fuego intenso' },
      { char: '❤️‍🩹', name: 'corazon sanando recuperacion vendaje alivio' },
      { char: '❣️', name: 'exclamacion corazon punto enfasis cariño' },
      { char: '💕', name: 'dos corazones flotando amor ternura enamorados' },
      { char: '💞', name: 'corazones girando amor correspondido vueltas' },
      { char: '💓', name: 'corazon latiendo ritmo emocion latido' },
      { char: '💗', name: 'corazon creciendo amor expansivo tierno' },
      { char: '💖', name: 'corazon brillante destellos magia especial lindo' },
      { char: '💘', name: 'flechazo cupido enamorado directo flecha' },
      { char: '💝', name: 'corazon con lazo regalo sorpresa entregado' },
      { char: '💟', name: 'adorno corazon decoracion purpura detalle' },
      { char: '💌', name: 'carta de amor mensaje carta sobre correo corazon' },
      { char: '💋', name: 'marca de beso labios mua besito' },
      { char: '💍', name: 'anillo compromiso boda promesa diamante casamiento' },
      { char: '💎', name: 'diamante joya valioso brillante gema lujo' }
    ]
  },
  objects: {
    name: 'Objetos y Festejo',
    icon: '🎉',
    emojis: [
      { char: '🎉', name: 'fiesta celebracion exito felicidades tada fiesta viva' },
      { char: '🎊', name: 'confetti fiesta alegria evento bola' },
      { char: '🎈', name: 'globo fiesta cumple decoracion cumpleaños' },
      { char: '🎁', name: 'regalo sorpresa presente caja moño' },
      { char: '🏆', name: 'trofeo premio copa ganador campeon primer lugar' },
      { char: '🥇', name: 'medalla oro primer lugar 1st campeon numero uno' },
      { char: '🥈', name: 'medalla plata segundo lugar 2nd plata' },
      { char: '🥉', name: 'medalla bronce tercer lugar 3rd bronce' },
      { char: '🎯', name: 'diana tiro blanco meta acierto objetivo justo' },
      { char: '🚀', name: 'cohete despegue exito crecimiento veloz space rapido' },
      { char: '💡', name: 'bombilla foco idea genial luz inspiracion eureka' },
      { char: '⚡', name: 'rayo trueno energia rapido electrico zap relampago' },
      { char: '🔥', name: 'fuego calor llama top crack tendencia lit caliente' },
      { char: '✨', name: 'brillos destellos magia nuevo limpio genial sparkles' },
      { char: '🌟', name: 'estrella brillante destacada excelente glow' },
      { char: '⭐', name: 'estrella favorito calificacion ranking' },
      { char: '💥', name: 'explosion impacto boom sorpresa choque' },
      { char: '💯', name: 'cien puntos perfecto 100 diez diez total calificacion' },
      { char: '🔔', name: 'campana notificacion alerta timbre aviso' },
      { char: '📣', name: 'megafono aviso anuncio comunicado megafono' },
      { char: '💬', name: 'burbuja mensaje chat comentario conversacion hablar' },
      { char: '💭', name: 'pensamiento idea sueño pensar burbuja nube' },
      { char: '📌', name: 'chincheta pin fijar importante recordar fijado' },
      { char: '📍', name: 'marcador mapa ubicacion aqui destino gps' },
      { char: '📎', name: 'clip adjunto anexo documento sujetapapeles' },
      { char: '📁', name: 'carpeta archivos organizacion folder' },
      { char: '📝', name: 'documento nota escribir texto lapiz apunte' },
      { char: '📅', name: 'calendario fecha cita evento dia agenda' },
      { char: '⏰', name: 'reloj despertador hora alarma tiempo temprano' },
      { char: '🔒', name: 'candado cerrado seguro clave privada seguridad' },
      { char: '🔑', name: 'llave acceso clave password abrir secreto' },
      { char: '💻', name: 'laptop computadora ordenador portatil trabajo code pc' },
      { char: '📱', name: 'celular smartphone telefono movil llamada mensaje' },
      { char: '🎧', name: 'auriculares musica podcast sonido canciones' },
      { char: '🎮', name: 'videojuegos control consola jugar gamer play' }
    ]
  },
  nature: {
    name: 'Naturaleza y Animales',
    icon: '🌿',
    emojis: [
      { char: '🐶', name: 'perro cachorro perrito dog mascota canino guau' },
      { char: '🐱', name: 'gato gatito cat miau mascota felino michi' },
      { char: '🦊', name: 'zorro astuto fox salvaje' },
      { char: '🐻', name: 'oso tierno bear peluche bosque' },
      { char: '🐼', name: 'panda osito lindo bamboo china' },
      { char: '🦁', name: 'leon rey fuerza selva lion felino' },
      { char: '🐯', name: 'tigre fiero rayas tiger selva' },
      { char: '🐵', name: 'mono mico chango monkey selva' },
      { char: '🦄', name: 'unicornio magia fantastico unicorn arcoiris' },
      { char: '🐝', name: 'abeja miel trabajo bee insecto' },
      { char: '🦋', name: 'mariposa transformacion belleza alas volar' },
      { char: '🌸', name: 'flor cerezo primavera rosa sakura flor' },
      { char: '🌺', name: 'flor hibisco tropical hawaiana' },
      { char: '🌻', name: 'girasol sol amarillo flor campo' },
      { char: '🌹', name: 'rosa roja amor flor rose romance' },
      { char: '🍀', name: 'trebol 4 hojas buena suerte fortuna verde' },
      { char: '🌱', name: 'brote planta inicio crecimiento verde brotar' },
      { char: '🌲', name: 'arbol pino bosque verde naturaleza madera' },
      { char: '🌳', name: 'arbol naturaleza verde roble sombra' },
      { char: '☀️', name: 'sol dia despejado calor brillante sun calido' },
      { char: '🌙', name: 'luna noche descanso cielo moon nocturno' },
      { char: '🌧️', name: 'lluvia clima mojado tormenta nublado gotas' },
      { char: '❄️', name: 'nieve copo invierno frio helado helada' },
      { char: '🌈', name: 'arcoiris esperanza colores diversidad paz cielo' }
    ]
  },
  food: {
    name: 'Comida y Bebida',
    icon: '🍕',
    emojis: [
      { char: '☕', name: 'cafe taza descanso caliente desayuno morning espresso' },
      { char: '🍵', name: 'te verde matcha infusion relajante bebida' },
      { char: '🍕', name: 'pizza comida queso cena antojo rebanada' },
      { char: '🍔', name: 'hamburguesa burger comida rapida queso carne' },
      { char: '🍟', name: 'papas fritas french fries aperitivo snack' },
      { char: '🌮', name: 'taco comida mexicana antojo carne tortilla' },
      { char: '🍿', name: 'palomitas cine pelicula pop corn palomitas de maiz' },
      { char: '🍩', name: 'dona donut postre dulce glaseada' },
      { char: '🍪', name: 'galleta cookie dulce chocolate galletita' },
      { char: '🍫', name: 'chocolate barra cacao dulce golosina' },
      { char: '🎂', name: 'pastel torta cumpleaños festejo cake velitas' },
      { char: '🧁', name: 'cupcake quequito dulce postre panquesito' },
      { char: '🍦', name: 'helado nieve cono conito dulce heladito' },
      { char: '🍎', name: 'manzana roja fruta saludable salud maestro' },
      { char: '🥑', name: 'aguacate palta guacamole saludable verde' },
      { char: '🍓', name: 'fresa frutilla roja fruta dulce' },
      { char: '🍉', name: 'sandia refrescante fruta fresca verano' },
      { char: '🍻', name: 'cervezas brindis salud cheers fiesta chelas' },
      { char: '🥂', name: 'copas champan brindis celebracion salud brindemos' },
      { char: '🍷', name: 'vino copa tinto relajacion cena uva' }
    ]
  }
};

function getFilteredEmojis(category, query) {
  const cleanQ = (query || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (cleanQ) {
    const results = [];
    const seen = new Set();
    Object.values(EMOJI_CATEGORIES).forEach(cat => {
      cat.emojis.forEach(item => {
        if (!seen.has(item.char)) {
          const cleanName = item.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          if (cleanName.includes(cleanQ) || item.char.includes(cleanQ)) {
            results.push(item);
            seen.add(item.char);
          }
        }
      });
    });
    return results;
  }
  const cat = EMOJI_CATEGORIES[category] || EMOJI_CATEGORIES.smileys;
  return cat.emojis || [];
}

function renderEmojiButtons(container, emojis, onSelect) {
  if (!container) return;
  container.innerHTML = '';
  if (!emojis || emojis.length === 0) {
    container.innerHTML = '<div style="grid-column: 1 / -1; padding: 22px 10px; text-align: center; color: var(--text-muted); font-size: 11.5px;">No se encontraron emojis</div>';
    return;
  }
  emojis.forEach(item => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-item-btn';
    b.textContent = item.char;
    b.title = item.name.split(' ')[0] || item.char;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSelect(item.char);
    });
    container.appendChild(b);
  });
}

function insertEmojiIntoInput(inputEl, emoji) {
  if (!inputEl) return;
  const start = inputEl.selectionStart !== null ? inputEl.selectionStart : inputEl.value.length;
  const end = inputEl.selectionEnd !== null ? inputEl.selectionEnd : inputEl.value.length;
  const val = inputEl.value;
  inputEl.value = val.substring(0, start) + emoji + val.substring(end);
  const nextPos = start + emoji.length;
  inputEl.setSelectionRange(nextPos, nextPos);
  inputEl.focus();
}

function insertEmojiIntoEditor(emoji) {
  if (!markdownInputEl) return;
  const start = markdownInputEl.selectionStart !== null ? markdownInputEl.selectionStart : markdownInputEl.value.length;
  const end = markdownInputEl.selectionEnd !== null ? markdownInputEl.selectionEnd : markdownInputEl.value.length;
  const val = markdownInputEl.value;
  markdownInputEl.value = val.substring(0, start) + emoji + val.substring(end);
  const nextPos = start + emoji.length;
  markdownInputEl.setSelectionRange(nextPos, nextPos);
  markdownInputEl.focus();
  renderMarkdown();
  scheduleSave();
}

let activeChatEmojiCategory = 'smileys';
let activeEditorEmojiCategory = 'smileys';

function toggleChatEmojiPicker(forceState = null) {
  const picker = document.getElementById('chat-emoji-picker');
  const btn = document.getElementById('btn-chat-emoji');
  if (!picker) return;

  const willShow = forceState !== null ? forceState : (picker.style.display === 'none' || !picker.style.display);
  picker.style.display = willShow ? 'flex' : 'none';
  btn?.classList.toggle('active', willShow);

  if (willShow) {
    const searchInput = document.getElementById('chat-emoji-search');
    if (searchInput) searchInput.value = '';
    renderChatEmojiGrid();
    setTimeout(() => searchInput?.focus(), 50);
  }
}

function renderChatEmojiGrid() {
  const grid = document.getElementById('chat-emoji-grid');
  const searchInput = document.getElementById('chat-emoji-search');
  const q = searchInput?.value || '';
  const emojis = getFilteredEmojis(activeChatEmojiCategory, q);
  renderEmojiButtons(grid, emojis, (char) => {
    insertEmojiIntoInput(document.getElementById('chat-message-input'), char);
  });
}

function toggleEditorEmojiPopover(forceState = null) {
  const popover = document.getElementById('editor-emoji-popover');
  if (!popover) return;

  const willShow = forceState !== null ? forceState : (popover.style.display === 'none' || !popover.style.display);
  popover.style.display = willShow ? 'flex' : 'none';

  if (willShow) {
    const searchInput = document.getElementById('editor-emoji-search');
    if (searchInput) searchInput.value = '';
    renderEditorEmojiGrid();
    setTimeout(() => searchInput?.focus(), 50);
  }
}

function renderEditorEmojiGrid() {
  const grid = document.getElementById('editor-emoji-grid');
  const searchInput = document.getElementById('editor-emoji-search');
  const q = searchInput?.value || '';
  const emojis = getFilteredEmojis(activeEditorEmojiCategory, q);
  renderEmojiButtons(grid, emojis, (char) => {
    insertEmojiIntoEditor(char);
    toggleEditorEmojiPopover(false);
  });
}

function setupEmojiPickers() {
  // 1. Selector de emojis para el CHAT
  const btnChatEmoji = document.getElementById('btn-chat-emoji');
  const chatSearch = document.getElementById('chat-emoji-search');
  const chatTabs = document.getElementById('chat-emoji-tabs');
  const chatQuick = document.getElementById('chat-emoji-quick');

  btnChatEmoji?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleChatEmojiPicker();
  });

  chatSearch?.addEventListener('input', () => {
    renderChatEmojiGrid();
  });

  chatTabs?.querySelectorAll('.emoji-tab-btn').forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      chatTabs.querySelectorAll('.emoji-tab-btn').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeChatEmojiCategory = tab.dataset.cat || 'smileys';
      const searchInput = document.getElementById('chat-emoji-search');
      if (searchInput) searchInput.value = '';
      renderChatEmojiGrid();
    });
  });

  chatQuick?.querySelectorAll('.emoji-quick-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const char = btn.dataset.emoji;
      if (char) {
        insertEmojiIntoInput(document.getElementById('chat-message-input'), char);
      }
    });
  });

  // 2. Popover de emojis para el EDITOR
  const editorSearch = document.getElementById('editor-emoji-search');
  const editorTabs = document.getElementById('editor-emoji-tabs');
  const editorQuick = document.getElementById('editor-emoji-quick');

  editorSearch?.addEventListener('input', () => {
    renderEditorEmojiGrid();
  });

  editorTabs?.querySelectorAll('.emoji-tab-btn').forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      editorTabs.querySelectorAll('.emoji-tab-btn').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeEditorEmojiCategory = tab.dataset.cat || 'smileys';
      const searchInput = document.getElementById('editor-emoji-search');
      if (searchInput) searchInput.value = '';
      renderEditorEmojiGrid();
    });
  });

  editorQuick?.querySelectorAll('.emoji-quick-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const char = btn.dataset.emoji;
      if (char) {
        insertEmojiIntoEditor(char);
        toggleEditorEmojiPopover(false);
      }
    });
  });

  // Cerrar popovers al hacer clic fuera
  document.addEventListener('click', (e) => {
    const editorPopover = document.getElementById('editor-emoji-popover');
    const btnToolbarEmoji = document.getElementById('btn-toolbar-emoji');
    if (editorPopover && editorPopover.style.display !== 'none') {
      if (!editorPopover.contains(e.target) && !btnToolbarEmoji?.contains(e.target)) {
        toggleEditorEmojiPopover(false);
      }
    }

    const chatPicker = document.getElementById('chat-emoji-picker');
    const btnChat = document.getElementById('btn-chat-emoji');
    const chatBar = document.getElementById('chat-message-form');
    if (chatPicker && chatPicker.style.display !== 'none') {
      if (!chatPicker.contains(e.target) && !btnChat?.contains(e.target) && !chatBar?.contains(e.target)) {
        toggleChatEmojiPicker(false);
      }
    }
  });
}

// Iniciar aplicación
document.addEventListener('DOMContentLoaded', init);
