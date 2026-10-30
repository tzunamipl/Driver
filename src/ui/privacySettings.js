import { PRIVACY_POLICY_URL } from '../config.js';
import { getConsent, setConsent, onConsentChange, leaderboardAllowed } from '../lib/privacy.js';
import { enableAnalytics, disableAnalytics } from '../lib/analytics.js';

// Analytics consent banner (until answered) + Settings > Gameplay > Privacy checkboxes.

export function createPrivacySettings() {
  for (const link of document.querySelectorAll('.privacy-link')) link.href = PRIVACY_POLICY_URL;

  const banner = document.getElementById('consent-banner');
  banner.addEventListener('click', (e) => {
    const answer = e.target.closest('[data-consent]')?.dataset.consent;
    if (!answer) return;
    setConsent('analytics', answer === 'yes');
    banner.hidden = true;
  });
  banner.hidden = getConsent('analytics') !== null;

  const inputs = {
    analytics: document.getElementById('analytics-consent-input'),
    leaderboard: document.getElementById('leaderboard-consent-input'),
  };
  for (const [kind, input] of Object.entries(inputs)) {
    input.checked = kind === 'leaderboard' ? leaderboardAllowed() : !!getConsent(kind);
    input.addEventListener('change', () => {
      setConsent(kind, input.checked);
      input.blur(); // Space is the handbrake, not a checkbox toggle
    });
  }

  onConsentChange((kind, granted) => {
    if (inputs[kind]) inputs[kind].checked = granted;
    if (kind !== 'analytics') return;
    if (granted) enableAnalytics();
    else disableAnalytics();
  });
  if (getConsent('analytics')) enableAnalytics();
}
