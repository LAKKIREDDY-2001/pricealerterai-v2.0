(function () {
  const slots = document.querySelectorAll('.ad-container');
  slots.forEach((slot) => {
    const id = slot.dataset.adSlot || 'slot';
    const label = slot.querySelector('.ad-label');
    if (label) label.textContent = `Advertisement • ${id}`;
  });
})();
