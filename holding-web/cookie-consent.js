// Cookie consent banner — GDPR/CCPA. Shared script, themed via cookie-consent.css per site.
(function() {
  const STORAGE_KEY = 'mclx_cookie_consent_v1';
  const CONSENT_EXPIRY_DAYS = 365;

  // Los textos estaban en duro en español. Con la versión inglesa del sitio ya
  // prerenderizada en /en/, eso dejaba al visitante angloparlante aceptando un
  // aviso que no puede leer — que es exactamente lo que el consentimiento
  // informado no es. Sigue el idioma del documento, no el del navegador: la
  // página que se está leyendo manda.
  const STRINGS = {
    es: {
      bannerTitle: 'Usamos cookies',
      bannerBody: 'Las esenciales son necesarias para el sitio. Las de analytics y marketing son opcionales — vos elegís. Ver ',
      privacy: 'Política de Privacidad',
      reject: 'Solo esenciales', customize: 'Personalizar', accept: 'Aceptar todas',
      modalTitle: 'Preferencias de cookies',
      modalBody: 'Elegí qué tipos de cookies aceptás. Las esenciales no se pueden desactivar.',
      essential: 'Esenciales', essentialDesc: 'Login, sesión, security. Sin estas el sitio no funciona.',
      analytics: 'Analytics', analyticsDesc: 'Datos agregados anónimos para mejorar el producto.',
      marketing: 'Marketing', marketingDesc: 'Recordar preferencias para campañas. Sin tracking cross-site.',
      cancel: 'Cancelar', save: 'Guardar'
    },
    en: {
      bannerTitle: 'We use cookies',
      bannerBody: 'Essential ones are required for the site. Analytics and marketing are optional — your call. See our ',
      privacy: 'Privacy Policy',
      reject: 'Essential only', customize: 'Customize', accept: 'Accept all',
      modalTitle: 'Cookie preferences',
      modalBody: 'Choose which cookies you accept. Essential ones cannot be turned off.',
      essential: 'Essential', essentialDesc: 'Login, session, security. The site does not work without these.',
      analytics: 'Analytics', analyticsDesc: 'Anonymous aggregated data to improve the product.',
      marketing: 'Marketing', marketingDesc: 'Remembering preferences for campaigns. No cross-site tracking.',
      cancel: 'Cancel', save: 'Save'
    }
  };
  const T = STRINGS[(document.documentElement.lang || 'es').slice(0, 2)] || STRINGS.es;
  function getConsent() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data.expiresAt && Date.now() > data.expiresAt) return null;
      return data;
    } catch (e) { return null; }
  }
  function saveConsent(analytics, marketing) {
    const data = {
      essential: true, analytics: !!analytics, marketing: !!marketing,
      timestamp: Date.now(),
      expiresAt: Date.now() + CONSENT_EXPIRY_DAYS * 86400000,
      version: 1
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    fireConsentEvent(data);
  }
  function fireConsentEvent(data) {
    window.dispatchEvent(new CustomEvent('cookieConsent', { detail: data }));
    if (typeof gtag === 'function') {
      gtag('consent', 'update', {
        analytics_storage: data.analytics ? 'granted' : 'denied',
        ad_storage: data.marketing ? 'granted' : 'denied',
        ad_user_data: data.marketing ? 'granted' : 'denied',
        ad_personalization: data.marketing ? 'granted' : 'denied'
      });
    }
  }
  const FOCUSABLES =
    'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * Atrapa el tabulador dentro del elemento y devuelve una función para soltarlo.
   *
   * El modal de preferencias se pinta sobre un backdrop, así que visualmente
   * bloquea la página — pero el tabulador seguía saliéndose por detrás, hacia
   * controles que el usuario no ve. Quien navega con teclado se perdía.
   */
  function atraparFoco(contenedor, alSalir) {
    const previo = document.activeElement;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        alSalir();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = contenedor.querySelectorAll(FOCUSABLES);
      if (!items.length) return;
      const primero = items[0];
      const ultimo = items[items.length - 1];
      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    const primerControl = contenedor.querySelector(FOCUSABLES);
    if (primerControl) primerControl.focus();
    return function soltar() {
      document.removeEventListener('keydown', onKey, true);
      // Devuelve el foco a donde estaba, no al principio de la página.
      if (previo && typeof previo.focus === 'function') previo.focus();
    };
  }

  function buildBanner() {
    const banner = document.createElement('div');
    banner.id = 'mclx-cookie-banner';
    // Sin `aria-modal` y sin Escape a propósito: el banner NO bloquea la página,
    // y cerrarlo con Escape sería registrar una decisión de consentimiento que
    // el usuario no tomó. Para decidir hay que pulsar uno de los tres botones.
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', T.bannerTitle);
    banner.innerHTML = `
      <div class="mclx-cc-inner">
        <div class="mclx-cc-text">
          <strong>${T.bannerTitle}</strong>
          <p>${T.bannerBody}<a href="/privacy">${T.privacy}</a>.</p>
        </div>
        <div class="mclx-cc-actions">
          <button id="mclx-cc-reject" class="mclx-cc-btn mclx-cc-btn-secondary" type="button">${T.reject}</button>
          <button id="mclx-cc-customize" class="mclx-cc-btn mclx-cc-btn-secondary" type="button">${T.customize}</button>
          <button id="mclx-cc-accept" class="mclx-cc-btn mclx-cc-btn-primary" type="button">${T.accept}</button>
        </div>
      </div>`;
    document.body.appendChild(banner);
    document.getElementById('mclx-cc-accept').addEventListener('click', () => { saveConsent(true, true); banner.remove(); });
    document.getElementById('mclx-cc-reject').addEventListener('click', () => { saveConsent(false, false); banner.remove(); });
    document.getElementById('mclx-cc-customize').addEventListener('click', () => { banner.remove(); buildModal(); });
  }
  function buildModal() {
    const modal = document.createElement('div');
    modal.id = 'mclx-cookie-modal';
    // Este sí es modal: hay backdrop y bloquea la interacción con la página.
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', T.modalTitle);
    modal.innerHTML = `
      <div class="mclx-mod-backdrop"></div>
      <div class="mclx-mod-card">
        <h3>${T.modalTitle}</h3>
        <p>${T.modalBody}</p>
        <div class="mclx-cat">
          <label class="mclx-cat-row">
            <input type="checkbox" checked disabled>
            <div><strong>${T.essential}</strong><small>${T.essentialDesc}</small></div>
          </label>
          <label class="mclx-cat-row">
            <input type="checkbox" id="mclx-mod-analytics">
            <div><strong>${T.analytics}</strong><small>${T.analyticsDesc}</small></div>
          </label>
          <label class="mclx-cat-row">
            <input type="checkbox" id="mclx-mod-marketing">
            <div><strong>${T.marketing}</strong><small>${T.marketingDesc}</small></div>
          </label>
        </div>
        <div class="mclx-mod-actions">
          <button id="mclx-mod-cancel" class="mclx-cc-btn mclx-cc-btn-secondary" type="button">${T.cancel}</button>
          <button id="mclx-mod-save" class="mclx-cc-btn mclx-cc-btn-primary" type="button">${T.save}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    // Escape equivale a Cancelar: vuelve al banner sin registrar decisión.
    const soltarFoco = atraparFoco(modal.querySelector('.mclx-mod-card'), () => {
      soltarFoco();
      modal.remove();
      buildBanner();
    });
    document.getElementById('mclx-mod-cancel').addEventListener('click', () => { soltarFoco(); modal.remove(); buildBanner(); });
    document.getElementById('mclx-mod-save').addEventListener('click', () => {
      saveConsent(document.getElementById('mclx-mod-analytics').checked, document.getElementById('mclx-mod-marketing').checked);
      soltarFoco();
      modal.remove();
    });
  }
  function init() {
    const existing = getConsent();
    if (existing) { fireConsentEvent(existing); return; }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildBanner);
    else buildBanner();
  }
  window.mclxCookie = {
    openPreferences: () => {
      document.getElementById('mclx-cookie-banner')?.remove();
      buildModal();
      const c = getConsent();
      if (c) {
        const a = document.getElementById('mclx-mod-analytics');
        const m = document.getElementById('mclx-mod-marketing');
        if (a) a.checked = !!c.analytics;
        if (m) m.checked = !!c.marketing;
      }
    },
    getConsent
  };
  init();
})();
