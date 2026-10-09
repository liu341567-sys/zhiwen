'use strict';

(() => {
  const toast = document.getElementById('toast');
  let sequence = 0;
  window.toastAPI.onMessage(message => {
    if (message.sequence !== sequence) {
      sequence = message.sequence;
      toast.className = `toast-card ${message.type}`;
      document.getElementById('toast-status').textContent = message.type === 'error' ? '!' : message.type === 'info' ? 'i' : '✓';
      document.getElementById('toast-message').textContent = message.message;
      toast.setAttribute('role', message.type === 'error' ? 'alert' : 'status');
      toast.setAttribute('aria-live', message.type === 'error' ? 'assertive' : 'polite');
      toast.hidden = false;
    }
    toast.classList.toggle('is-leaving', message.leaving === true);
    window.toastAPI.resized(sequence, Math.ceil(toast.getBoundingClientRect().height + 16));
  });
  new ResizeObserver(() => {
    if (sequence) window.toastAPI.resized(sequence, Math.ceil(toast.getBoundingClientRect().height + 16));
  }).observe(toast);
})();
