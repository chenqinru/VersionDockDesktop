/* global URLSearchParams, location, document */
const params = new URLSearchParams(location.search);
const name = params.get('name') || '';
const theme = params.get('theme');
const initials = params.get('initials');
const color = params.get('color');

document.body.classList.toggle('light', theme === 'light');
const titleEl = document.querySelector('span.titlebar-tab-title');
if (titleEl) {
  titleEl.textContent = name;
}

const iconEl = document.querySelector('.project-icon');
const lettersEl = document.querySelector('.project-icon-letters');

if (iconEl && lettersEl) {
  const resolvedInitials = initials || (name ? name.slice(0, 1).toUpperCase() : '?');
  lettersEl.textContent = resolvedInitials;
  if (resolvedInitials.length > 1) {
    iconEl.classList.add('two-letters');
  }
  if (color) {
    iconEl.style.backgroundColor = color;
  }
}
