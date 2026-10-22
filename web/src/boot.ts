// Start page: opens the interface chosen in the owner section (TV Hub /mode).
// If the local API does not answer, it retries; after that it falls back to the kids interface,
// the restrictive choice, so a child never lands on the family dashboard by accident.
import { getMode, pageFor } from './shared/hub';

const DELAYS = [300, 700, 1500, 3000, 5000, 8000, 10000];   // ~28 s: a slow cold boot must not show the wrong interface

function go(attempt: number): void {
  getMode()
    .then((m) => location.replace(pageFor(m)))
    .catch(() => {
      if (attempt < DELAYS.length) setTimeout(() => go(attempt + 1), DELAYS[attempt]);
      else location.replace(pageFor('kids'));
    });
}

go(0);
