// Settings "GitHub" section: the personal access token the scenario editor saves with.

import { TOKEN_HELP_URL, readToken, writeToken } from '../lib/scenarios/github.js';

export function createGithubSettings() {
  const input = document.getElementById('github-token-input');
  document.getElementById('github-token-help').href = TOKEN_HELP_URL;
  const showSaved = () => (input.placeholder = readToken() ? 'Token saved (paste to replace)' : 'ghp_…');
  showSaved();

  input.addEventListener('change', () => {
    writeToken(input.value.trim());
    input.value = '';
    showSaved();
  });
}
