// Live DOM reordering while dragging; persistence happens only on drop/key action.
const bindings = new WeakMap();
export function reorderCards(container, onCommit) {
  bindings.get(container)?.abort();
  const controller = new AbortController();
  bindings.set(container, controller);
  const options = { signal: controller.signal };
  let dragging = null;
  let original = [];
  let pointerDrag = null;
  const ordered = () => [...container.children].filter(node => node.dataset.pokemonId);
  const commit = () => Promise.resolve(onCommit(ordered().map(node => node.dataset.pokemonId))).catch(error => {
    container.dispatchEvent(new CustomEvent('reordererror', { bubbles: true, detail: error }));
  });
  const isInteractive = target => Boolean(target.closest('button,input,select,textarea,label,a'));
  for (const card of ordered()) {
    card.querySelector('.party-drag-handle')?.remove();
    card.classList.add('is-reorderable');
    card.draggable = false;
    card.tabIndex = 0;
    card.setAttribute('aria-description', 'Drag to reorder, or use the left and right arrow keys while the card is focused.');
    card.addEventListener('keydown', event => {
      if (event.target !== card) return;
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const sibling = event.key === 'ArrowLeft' ? card.previousElementSibling : card.nextElementSibling;
      if (!sibling?.dataset.pokemonId) return;
      if (event.key === 'ArrowLeft') container.insertBefore(card, sibling);
      else container.insertBefore(sibling, card);
      card.focus(); commit();
    });
    card.addEventListener('pointerdown', event => {
      if (event.button !== 0 || isInteractive(event.target)) return;
      event.preventDefault();
      card.focus();
      pointerDrag = { card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, original: [...container.children] };
    }, options);
  }
  document.addEventListener('pointermove', event => {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    if (!dragging && Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) < 4) return;
    event.preventDefault();
    if (!dragging) {
      dragging = pointerDrag.card;
      original = pointerDrag.original;
      dragging.classList.add('is-dragging');
      container.classList.add('is-card-dragging');
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-pokemon-id]');
    if (!target || target.parentElement !== container || target === dragging) return;
    const cards = ordered();
    container.insertBefore(dragging, cards.indexOf(dragging) < cards.indexOf(target) ? target.nextSibling : target);
  }, options);
  document.addEventListener('pointerup', event => {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    pointerDrag = null;
    if (!dragging) return;
    dragging.classList.remove('is-dragging');
    container.classList.remove('is-card-dragging');
    dragging = null;
    commit();
  }, options);
  document.addEventListener('pointercancel', event => {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    pointerDrag = null;
    if (dragging) {
      container.replaceChildren(...original);
      dragging.classList.remove('is-dragging');
      dragging = null;
    }
    container.classList.remove('is-card-dragging');
  }, options);
}
