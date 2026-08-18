// Cookie consent banner — GDPR/CCPA compliant
// Same script as DEDUTH adultos. Stored consent in localStorage; fires window event 'cookieConsent'
(function() {
  const STORAGE_KEY = 'mclx_cookie_consent_v1';
  const CONSENT_EXPIRY_DAYS = 365;
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
  function buildBanner() {
    const banner = document.createElement('div');
    banner.id = 'mclx-cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-labelledby', 'mclx-cc-title');
    banner.innerHTML = `
      <div class="mclx-cc-inner">
        <div class="mclx-cc-text">
          <strong id="mclx-cc-title">Usamos cookies</strong>
          <p>Las esenciales son necesarias para el sitio. Las de analytics y marketing son opcionales — vos elegís. Ver <a href="/privacy">Política de Privacidad</a>.</p>
        </div>
        <div class="mclx-cc-actions">
          <button id="mclx-cc-reject" class="mclx-cc-btn mclx-cc-btn-secondary" type="button">Solo esenciales</button>
          <button id="mclx-cc-customize" class="mclx-cc-btn mclx-cc-btn-secondary" type="button">Personalizar</button>
          <button id="mclx-cc-accept" class="mclx-cc-btn mclx-cc-btn-primary" type="button">Aceptar todas</button>
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
    modal.innerHTML = `
      <div class="mclx-mod-backdrop"></div>
      <div class="mclx-mod-card">
        <h3>Preferencias de cookies</h3>
        <p>Elegí qué tipos de cookies aceptás. Las esenciales no se pueden desactivar.</p>
        <div class="mclx-cat">
          <label class="mclx-cat-row">
            <input type="checkbox" checked disabled>
            <div><strong>Esenciales</strong><small>Login, sesión, security. Sin estas el sitio no funciona.</small></div>
          </label>
          <label class="mclx-cat-row">
            <input type="checkbox" id="mclx-mod-analytics">
            <div><strong>Analytics</strong><small>Datos agregados anónimos para mejorar el producto.</small></div>
          </label>
          <label class="mclx-cat-row">
            <input type="checkbox" id="mclx-mod-marketing">
            <div><strong>Marketing</strong><small>Recordar preferencias para campañas. Sin tracking cross-site.</small></div>
          </label>
        </div>
        <div class="mclx-mod-actions">
          <button id="mclx-mod-cancel" class="mclx-cc-btn mclx-cc-btn-secondary" type="button">Cancelar</button>
          <button id="mclx-mod-save" class="mclx-cc-btn mclx-cc-btn-primary" type="button">Guardar</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('mclx-mod-cancel').addEventListener('click', () => { modal.remove(); buildBanner(); });
    document.getElementById('mclx-mod-save').addEventListener('click', () => {
      saveConsent(document.getElementById('mclx-mod-analytics').checked, document.getElementById('mclx-mod-marketing').checked);
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
