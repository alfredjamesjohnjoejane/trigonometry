import { openAboutBlankShell, appendShellIframe } from '../cloak/index.js';

// Pinned GeoGebra version with SRI slot. Unversioned deployggb.js is a
// supply-chain risk (page compromise = code in the calculator tab).
const GEOGEBRA_URL = 'https://www.geogebra.org/apps/deployggb.js';
const GEOGEBRA_SRI = '';

const CALCULATOR_TITLE = '√ Calculator';

const FAVICON_SVG =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48dGV4dCB5PSIuOWVtIiBmb250LXNpemU9IjkwIj7iiJ48L3RleHQ+PC9zdmc+';

const CLASSROOM_ICON = 'https://ssl.gstatic.com/classroom/favicon.png';

function writeCalculatorPage(w: Window): void {
  // DOM-only construction: document.open/write on the new tab re-URLs it to
  // this page's URL in current Chrome, defeating the about:blank cloak.
  // The GeoGebra script runs in the new tab (not the hub), with SRI when set.
  try {
    const d = w.document;
    d.title = CALCULATOR_TITLE;
    d.body.style.cssText =
      'display:flex;flex-direction:column;margin:0;height:100vh;background:#111;font-family:Segoe UI,system-ui,sans-serif';
    const bar = d.createElement('div');
    bar.style.cssText =
      'height:54px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;background:rgba(0,0,0,.85);border-bottom:1px solid rgba(255,255,255,.12);color:#e0e0e0;flex-shrink:0';
    const back = d.createElement('button');
    back.textContent = '← Back to Hub';
    back.style.cssText =
      'border:none;border-radius:10px;padding:8px 16px;font-weight:700;cursor:pointer;background:rgba(255,255,255,.08);color:#fff';
    back.addEventListener('click', () => {
      try {
        if (window.opener && !window.opener.closed) window.opener.focus();
      } catch {
        /* ignore */
      }
      try {
        w.close();
      } catch {
        /* ignore */
      }
    });
    const ttl = d.createElement('span');
    ttl.textContent = CALCULATOR_TITLE;
    ttl.style.fontWeight = '800';
    const close = d.createElement('button');
    close.textContent = '✕ Close';
    close.style.cssText = back.style.cssText;
    close.addEventListener('click', () => {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    });
    bar.append(back, ttl, close);
    const wrap = d.createElement('div');
    wrap.id = 'ggb-wrap';
    wrap.style.cssText = 'width:100%;flex:1;overflow:hidden';
    d.body.append(bar, wrap);
    const err = d.createElement('div');
    err.style.cssText = 'color:#e0e0e0;padding:24px;text-align:center;display:none';
    err.textContent = 'Calculator failed to load. Check connection and retry.';
    d.body.appendChild(err);
    const s = d.createElement('script');
    s.src = GEOGEBRA_URL;
    if (GEOGEBRA_SRI) s.integrity = GEOGEBRA_SRI;
    s.crossOrigin = 'anonymous';
    s.onerror = () => {
      err.style.display = 'block';
    };
    s.onload = () => {
      try {
        const boot = d.createElement('script');
        boot.textContent = `var params={appName:"cas",width:window.innerWidth,height:window.innerHeight-54,showToolBar:true,showAlgebraInput:true,showMenuBar:false,showFullscreenButton:true,showResetIcon:true,enableRightClick:true,enableShiftDragZoom:true};var applet=new GGBApplet(params,true);window.addEventListener("load",function(){applet.inject('ggb-wrap');});if(document.readyState==="complete")applet.inject('ggb-wrap');`;
        d.body.appendChild(boot);
      } catch {
        err.style.display = 'block';
      }
    };
    d.head.appendChild(s);
    const l = d.createElement('link');
    l.rel = 'icon';
    l.href = FAVICON_SVG;
    d.head.appendChild(l);
  } catch {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
}

function writeProxyPage(): void {
  const shell = openAboutBlankShell('Google Classroom', CLASSROOM_ICON);
  if (!shell) return;
  appendShellIframe(shell, { srcdoc: PROXY_HTML });
  try {
    shell.win.focus();
  } catch (e) {}
}

function writeCinemaOSPage(): void {
  const shell = openAboutBlankShell('Media', FAVICON_SVG);
  if (!shell) return;
  appendShellIframe(shell, { srcdoc: CINEMAOS_HTML });
  try {
    shell.win.focus();
  } catch (e) {}
}

const PROXY_HTML =
  '<!DOCTYPE html><html><head><title>Google Classroom</title><link rel="icon" href="https://ssl.gstatic.com/classroom/favicon.png"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:Segoe UI,system-ui,sans-serif}.shell{width:100%;height:100%;display:flex;flex-direction:column}.bar{height:56px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:rgba(0,0,0,.85);border-bottom:1px solid rgba(255,255,255,.12);color:#e0e0e0}.ttl{font-weight:800;color:#e0e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.acts{display:flex;gap:10px;align-items:center}.bar button{border:none;border-radius:10px;padding:8px 14px;font-weight:800;cursor:pointer}.back{background:#555;color:#111}.close{background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.12)}iframe{width:100%;height:calc(100% - 56px);border:none;background:#000}</style></head><body><div class="shell"><div class="bar"><button class="back" onclick="try{if(window.top&&window.top.opener&&!window.top.opener.closed){window.top.opener.focus();window.top.close()}}catch(e){}history.back()}">← Back to Landing</button><div class="ttl">🌐 Proxy</div><div class="acts"><button class="close" onclick="try{window.top.close()}catch(e){}">✕ Close</button></div></div><iframe src="https://nebulaisgud.neocities.org" allow="fullscreen; autoplay"></iframe></div></body></html>';

const CINEMAOS_HTML =
  '<!DOCTYPE html><html><head><title>Media</title><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:Segoe UI,system-ui,sans-serif}.shell{width:100%;height:100%;display:flex;flex-direction:column}.bar{height:56px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:rgba(0,0,0,.85);border-bottom:1px solid rgba(255,255,255,.12);color:#e0e0e0}.ttl{font-weight:800;color:#e0e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.acts{display:flex;gap:10px;align-items:center}.bar button{border:none;border-radius:10px;padding:8px 14px;font-weight:800;cursor:pointer}.back{background:#555;color:#111}.close{background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.12)}.stage{position:relative;flex:1}.stage iframe{position:absolute;inset:0;width:100%;height:100%;border:none;background:#000}#L{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#888;font-size:24px;font-family:sans-serif;z-index:2}</style></head><body><div class="shell"><div class="bar"><button class="back" onclick="try{if(window.top&&window.top.opener&&!window.top.opener.closed){window.top.opener.focus();window.top.close()}}catch(e){}history.back()}">← Back to Landing</button><div class="ttl">🎬 Media</div><div class="acts"><button class="close" onclick="try{window.top.close()}catch(e){}">✕ Close</button></div></div><div class="stage"><div id="L">Loading...</div><iframe src="https://cinemaos.live" allow="fullscreen; autoplay" onload="document.getElementById(\'L\').style.display=\'none\'"></iframe></div></div></body></html>';

function openCalculator(): void {
  let w: Window | null = null;
  try {
    w = window.open('about:blank', '_blank', 'noopener,noreferrer');
  } catch {
    w = null;
  }
  if (!w) return;
  try {
    if (w.opener) {
      try {
        (w as Window & { opener?: null }).opener = null;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  writeCalculatorPage(w);
}

function openProxy(): void {
  writeProxyPage();
}

function openCinemaOS(): void {
  writeCinemaOSPage();
}

export {
  writeCalculatorPage,
  writeProxyPage,
  writeCinemaOSPage,
  openCalculator,
  openProxy,
  openCinemaOS,
};
