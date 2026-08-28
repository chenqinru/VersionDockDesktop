/* global URLSearchParams, location, document */
const params = new URLSearchParams(location.search);
document.body.classList.toggle('light', params.get('theme') === 'light');
document.querySelector('span').textContent = params.get('name') || '';
