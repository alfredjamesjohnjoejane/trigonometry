const ST = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      // Quota/blocked storage: warn instead of silently pretending the save
      // worked — settings would otherwise appear saved but vanish on reload.
      try {
        if (
          e instanceof DOMException &&
          (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
        ) {
          console.warn('[Storage] quota exceeded, setting not saved:', key);
        }
      } catch {
        /* ignore */
      }
    }
  },
  remove: (key: string): void => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export default ST;
