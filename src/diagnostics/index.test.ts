import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyFailure,
  describeError,
  formatReportText,
  getEnvironmentSnapshot,
  guessLikelyCause,
  probeBackend,
  probeLuminInit,
  _resetLogs,
  type DiagReport,
  type ProbeResult,
} from './index.js';
import {
  _resetLuminState,
  claimLuminInit,
  markLuminInitFailed,
  markLuminInitOk,
} from '../lumin-state/index.js';

function probe(name: string, ok: boolean, extra: Partial<ProbeResult> = {}): ProbeResult {
  return {
    name,
    url: 'https://example.com/x',
    method: 'fetch-cors',
    ok,
    httpStatus: ok ? 200 : null,
    ms: ok ? 120 : null,
    errorName: ok ? null : 'TypeError',
    errorMessage: ok ? null : 'Failed to fetch',
    classification: ok ? 'ok' : 'network-blocked-or-filtered',
    note: null,
    ...extra,
  };
}

function baseReport(): DiagReport {
  return {
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    env: getEnvironmentSnapshot(),
    probes: [],
    lumin: {
      attempted: false,
      present: false,
      initType: 'undefined',
      ok: false,
      errorName: null,
      errorMessage: null,
      ms: null,
      luminFetchUrls: [],
    },
    recentLogs: [],
    likelyCause: 'test',
    checklist: ['step 1'],
  };
}

beforeEach(() => {
  _resetLogs();
  vi.unstubAllGlobals();
});

describe('describeError', () => {
  it('handles null, strings, and Errors', () => {
    expect(describeError(null)).toBe('null');
    expect(describeError('oops')).toBe('oops');
    expect(describeError(new TypeError('bad'))).toContain('TypeError');
  });
});

describe('classifyFailure', () => {
  it('classifies aborts as timeout', () => {
    expect(classifyFailure(new DOMException('aborted', 'AbortError'), 8100)).toMatch(/timeout/);
  });

  it('reports offline when navigator is offline', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(classifyFailure(new TypeError('Failed to fetch'), 50)).toBe('offline');
  });

  it('flags CSP messages', () => {
    expect(classifyFailure(new Error('Refused by Content Security Policy'), 10)).toBe(
      'csp-blocked'
    );
  });

  it('defaults cross-origin TypeError to filter bucket', () => {
    expect(classifyFailure(new TypeError('Failed to fetch'), 100)).toBe(
      'network-blocked-or-filtered'
    );
  });
});

describe('guessLikelyCause', () => {
  it('detects offline / captive portal when everything fails', () => {
    const cause = guessLikelyCause(
      [probe('same-origin: catalog', false), probe('cdn: jsDelivr', false)],
      {
        attempted: false,
        present: false,
        initType: 'undefined',
        ok: false,
        errorName: null,
        errorMessage: null,
        ms: null,
        luminFetchUrls: [],
      }
    );
    expect(cause).toMatch(/OFFLINE-or-captive-portal/);
  });

  it('detects school filter when same-origin passes but CDN fails', () => {
    const cause = guessLikelyCause(
      [probe('same-origin: catalog', true), probe('cdn: jsDelivr', false)],
      {
        attempted: false,
        present: false,
        initType: 'undefined',
        ok: false,
        errorName: null,
        errorMessage: null,
        ms: null,
        luminFetchUrls: [],
      }
    );
    expect(cause).toMatch(/SCHOOL-FILTER/);
  });

  it('detects Lumin.init rejection', () => {
    const cause = guessLikelyCause(
      [probe('same-origin: catalog', true), probe('cdn: jsDelivr', true)],
      {
        attempted: true,
        present: true,
        initType: 'function',
        ok: false,
        errorName: 'Error',
        errorMessage: 'backend blocked',
        ms: 300,
        luminFetchUrls: [],
      }
    );
    expect(cause).toMatch(/LUMIN-INIT failed/);
  });

  it('detects partial mirror block when some Lumin mirrors pass', () => {
    const cause = guessLikelyCause(
      [
        probe('same-origin: catalog', true),
        probe('cdn: Lumin SDK', true),
        probe('cdn: Lumin SDK (fastly)', false),
      ],
      {
        attempted: false,
        present: false,
        initType: 'undefined',
        ok: false,
        errorName: null,
        errorMessage: null,
        ms: null,
        luminFetchUrls: [],
      }
    );
    expect(cause).toMatch(/PARTIAL-MIRROR-BLOCK/);
  });

  it('detects path filter when all Lumin mirrors fail but favicon passes', () => {
    const cause = guessLikelyCause(
      [
        probe('same-origin: catalog', true),
        probe('cdn: jsDelivr', true),
        probe('cdn: Lumin SDK', false),
        probe('cdn: Lumin SDK (fastly)', false),
      ],
      {
        attempted: false,
        present: false,
        initType: 'undefined',
        ok: false,
        errorName: null,
        errorMessage: null,
        ms: null,
        luminFetchUrls: [],
      }
    );
    expect(cause).toMatch(/FILTER-ON-LUMIN-PATH/);
  });

  it('detects backend block when scripts pass but all backends fail', () => {
    const cause = guessLikelyCause(
      [
        probe('same-origin: catalog', true),
        probe('cdn: Lumin SDK', true),
        probe('backend: Lumin backend (primary)', false),
        probe('backend: Lumin backend (mirror 1)', false),
      ],
      {
        attempted: true,
        present: true,
        initType: 'function',
        ok: false,
        errorName: 'Error',
        errorMessage: 'boot',
        ms: 5000,
        luminFetchUrls: [],
      }
    );
    expect(cause).toMatch(/LUMIN-BACKEND-BLOCKED/);
  });

  it('detects worker-file block when scripts+backends pass but worker files fail', () => {
    const cause = guessLikelyCause(
      [
        probe('same-origin: catalog', true),
        probe('cdn: Lumin SDK', true),
        probe('backend: Lumin backend (primary)', true),
        probe('worker: Lumin worker (primary)', false),
        probe('worker: Lumin worker (mirror 1)', false),
        probe('worker: Lumin worker (proxy)', false),
      ],
      {
        attempted: true,
        present: true,
        initType: 'function',
        ok: false,
        errorName: 'Error',
        errorMessage: 'domain fetch failed',
        ms: 5000,
        luminFetchUrls: [],
      }
    );
    expect(cause).toMatch(/LUMIN-WORKER-BLOCKED/);
  });

  it('prefers LUMIN-INIT over PARTIAL-MIRROR-BLOCK when init ran and failed', () => {
    // Shape of the 2026-10-15 school report: vendor copy loaded + executed
    // (present-with-init) but Lumin.init rejected with "domain fetch failed"
    // while backends/workers all passed. The old ordering blamed the mirror
    // split even though the script demonstrably executed.
    const cause = guessLikelyCause(
      [
        probe('same-origin: catalog', true),
        probe('cdn: Lumin SDK', false),
        probe('cdn: Lumin SDK (fastly)', false),
        probe('cdn: Lumin SDK (gcore)', false),
        probe('cdn: Lumin SDK (testingcf)', false),
        probe('cdn: Lumin SDK (worker proxy)', true),
        probe('backend: Lumin backend (worker proxy)', true),
        probe('backend: Lumin backend (primary)', true),
        probe('worker: Lumin worker (proxy)', true),
        probe('worker: Lumin worker (primary)', true),
      ],
      {
        attempted: true,
        present: true,
        initType: 'function',
        ok: false,
        errorName: 'Error',
        errorMessage: 'Error: domain fetch failed',
        ms: 1,
        luminFetchUrls: [],
      }
    );
    expect(cause).toMatch(/LUMIN-INIT failed/);
    expect(cause).not.toMatch(/PARTIAL-MIRROR-BLOCK/);
  });

  it('does not cry backend-blocked when a no-cors row shows the host alive', () => {
    const cause = guessLikelyCause(
      [
        probe('same-origin: catalog', true),
        probe('cdn: Lumin SDK', true),
        probe('backend: Lumin backend (primary)', false),
        probe('backend: Lumin backend (primary) (no-cors)', true),
      ],
      {
        attempted: true,
        present: true,
        initType: 'function',
        ok: false,
        errorName: 'Error',
        errorMessage: 'boot',
        ms: 5000,
        luminFetchUrls: [],
      }
    );
    expect(cause).not.toMatch(/LUMIN-BACKEND-BLOCKED/);
  });
});

describe('formatReportText', () => {
  it('renders a pasteable report with probes and cause', () => {
    const r = baseReport();
    r.probes = [probe('same-origin: catalog', true), probe('cdn: jsDelivr', false)];
    r.likelyCause = 'SCHOOL-FILTER guess';
    const text = formatReportText(r);
    expect(text).toContain('diagnostic report');
    expect(text).toContain('LIKELY CAUSE');
    expect(text).toContain('PASS');
    expect(text).toContain('FAIL');
  });
});

describe('getEnvironmentSnapshot', () => {
  it('never throws and returns required fields', () => {
    const env = getEnvironmentSnapshot();
    expect(typeof env.href).toBe('string');
    expect(typeof env.onLine).toBe('boolean');
    expect(typeof env.luminGlobal).toBe('string');
  });
});

describe('probeBackend', () => {
  it('treats bare-path 404 as host-reachable (boot token appended at runtime)', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('none', { status: 404, headers: { 'content-type': 'text/plain' } })
    );
    const r = await probeBackend('backend: x', 'https://example.com/api/v1/boot', 1000);
    expect(r.ok).toBe(true);
    expect(r.classification).toBe('http-404-reachable');
  });

  it('keeps network failures as failures', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const r = await probeBackend('backend: x', 'https://example.com/api/v1/boot', 1000);
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBeNull();
  });
});

describe('probeLuminInit', () => {
  beforeEach(() => {
    _resetLuminState();
  });

  it('never starts a second init when the page already ran one', async () => {
    // A second Lumin.init() destroys the grid that is already rendered and
    // then fails with "domain fetch failed" — the diagnostics panel must
    // never trigger it.
    claimLuminInit();
    markLuminInitOk();
    const initSpy = vi.fn();
    (window as unknown as { Lumin?: unknown }).Lumin = { init: initSpy };
    const res = await probeLuminInit(1000);
    expect(initSpy).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.attempted).toBe(true);
  });

  it('reports the failure of the init the page already ran', async () => {
    claimLuminInit();
    markLuminInitFailed(new Error('domain fetch failed'));
    const initSpy = vi.fn();
    (window as unknown as { Lumin?: unknown }).Lumin = { init: initSpy };
    const res = await probeLuminInit(1000);
    expect(initSpy).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toBe('domain fetch failed');
  });
});
