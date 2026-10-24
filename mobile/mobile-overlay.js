// Conchilla on Android: the chat-card layer runs in a see-through frame over the stream.
// This stands in for the overlay window's Electron bridge and talks to the main page directly.
(function () {
  const listeners = {};
  const on = (ch) => (fn) => { (listeners[ch] = listeners[ch] || []).push(fn); };
  window.__conchillaIn = (ch, data) => {
    (listeners[ch] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
    // the phone keyboard only opens when the box is focused right away (inside the tap)
    if (ch === 'overlay:open' && data !== 'quick') document.getElementById('compose')?.focus();
  };
  const parent = window.parent;
  window.conchilla = {
    getSettings: () => parent.conchilla.getSettings(),
    overlayEvents: on('overlay:event'),
    onOverlayOpen: on('overlay:open'),
    onOverlayClose: on('overlay:close'),
    onOverlaySettings: on('overlay:settings'),
    onMoveMode: on('overlay:move-mode'),
    overlayClosed: () => parent.__conchillaFromOverlay('closed'),
    fromOverlay: (msg) => parent.__conchillaFromOverlay('from-overlay', msg),
  };

  document.addEventListener('DOMContentLoaded', () => {
    // tap outside the chat box: close it (the draft stays)
    document.addEventListener('pointerdown', (e) => {
      const box = document.getElementById('composer');
      if (box && !box.hidden && !e.target.closest('#composer')) window.__conchillaIn('overlay:close');
    });
    const style = document.createElement('style');
    style.textContent = `
      body.mobile #root { padding: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) 8px max(8px, env(safe-area-inset-left)); }
      body.mobile .call { max-width: min(100%, 78vw); }
      body.mobile #composer { max-width: 560px; width: 100%; }
      body.right #composer { align-self: flex-end; }
      body.mobile #compose { font-size: 16px; }   /* 16px+: the phone doesn't zoom in on focus */
      body.mobile #history { max-height: 30vh; }`;
    document.head.appendChild(style);
  });
})();
