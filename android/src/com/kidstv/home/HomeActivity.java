package com.kidstv.home;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.File;

/**
 * Home screen that shows the TV page itself in a built-in WebView (replaces Fully Kiosk).
 *
 *  - Boot / Home press land here; the page stays loaded (singleTask).
 *  - Remote Back never leaves the page: it is forwarded to the page as a keydown (key "GoBack", keyCode 4).
 *  - Kids interface: the top frame may only show pages from the local server; iframes (YouTube player) are not restricted.
 *  - Home interface: internet pages (quick links) open here too; Back goes back through them, then to the dashboard,
 *    and the remote's arrows move between their links (spatial navigation injected into the page).
 *  - A crashed or failed page is reloaded automatically.
 */
public class HomeActivity extends Activity {
    static final String TAG = "TVHub";
    private static final String ORIGIN = "http://127.0.0.1:" + LauncherService.PORT;
    private static final String PAGE_URL = ORIGIN + "/";
    private static final long RETRY_MS = 3000;

    /**
     * Remote navigation for internet pages (WebView has no spatial navigation of its own): arrows focus the nearest
     * link/button/field in that direction and scroll when there is none; OK clicks. Installed once per page.
     */
    private static final String SPATIAL_NAV =
            "(function(){if(window.__hubNav)return;window.__hubNav=1;" +
            "var S='a[href],button,input,select,textarea,[tabindex]:not([tabindex=\"-1\"]),[role=button],[onclick]';" +
            "function vis(e){var r=e.getBoundingClientRect();return r.width>2&&r.height>2&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&getComputedStyle(e).visibility!=='hidden';}" +
            "function c(r){return{x:r.left+r.width/2,y:r.top+r.height/2};}" +
            // bubble phase on window + defaultPrevented: sites that handle the arrows themselves keep them (AUDIT-2 N8)
            "window.addEventListener('keydown',function(e){if(e.defaultPrevented)return;var k=e.keyCode,a=document.activeElement;" +
            "if(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)&&(k===37||k===39))return;" +
            "var d={37:[-1,0],38:[0,-1],39:[1,0],40:[0,1]}[k];if(!d)return;" +
            "var cur=(a&&a!==document.body&&vis(a))?c(a.getBoundingClientRect()):{x:innerWidth/2,y:d[1]>0?-1:innerHeight+1};" +
            "var best=null,bd=1e9;document.querySelectorAll(S).forEach(function(el){if(el===a||!vis(el))return;var p=c(el.getBoundingClientRect()),dx=p.x-cur.x,dy=p.y-cur.y;" +
            "var main=d[0]?dx*d[0]:dy*d[1];if(main<=1)return;var cross=d[0]?Math.abs(dy):Math.abs(dx)/3;var s=main+cross*2;if(s<bd){bd=s;best=el;}});" +
            "e.preventDefault();if(best){best.focus({preventScroll:false});best.scrollIntoView({block:'nearest',inline:'nearest'});}" +
            "else window.scrollBy(d[0]*innerWidth*0.4,d[1]*innerHeight*0.4);},false);" +
            "var st=document.createElement('style');st.textContent=':focus{outline:4px solid #fbbf24!important;outline-offset:2px!important}';document.head&&document.head.appendChild(st);})()";

    private final Handler ui = new Handler(Looper.getMainLooper());

    // ---- screen policy (AUDIT L4, revised after the kids TV could not be woken) ----
    // The screen stays on, as before. Only if device.json has "allowSleep": true does the kids interface let the TV's
    // own screensaver / sleep timers run after 20 minutes without a key (never while something plays). Some boxes
    // (Xiaomi MiTV-AFMU0) fell into a deep sleep that the remote could not wake, so sleeping is opt-in.
    private static final long KIDS_IDLE_MS = 20 * 60 * 1000;
    private static volatile HomeActivity current;
    private static volatile boolean playing = false;
    private long lastInput = System.currentTimeMillis();
    private final Runnable screenTick = new Runnable() {
        @Override public void run() { applyScreenPolicy(); ui.postDelayed(this, 30_000); }
    };

    /** Called by LauncherService when the page starts/stops a video or channel. */
    static void setPlaying(boolean p) {
        playing = p;
        HomeActivity a = current;
        if (a != null) a.ui.post(a::applyScreenPolicy);
    }

    private void applyScreenPolicy() {
        boolean allowSleep = "kids".equals(LauncherService.modeOf(this))
                && LauncherService.readDeviceFile().optBoolean("allowSleep", false);
        boolean keep = !allowSleep || playing || System.currentTimeMillis() - lastInput < KIDS_IDLE_MS;
        if (keep) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
    private FrameLayout root;
    private WebView web;
    private View customView;   // HTML5 fullscreen video, if any
    private WebChromeClient.CustomViewCallback customCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = this;
        applyScreenPolicy();
        ui.postDelayed(screenTick, 30_000);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        startApi();
        createWebView();
        loadWhenServerReady();
    }

    /** Local server: page files, app list/launch API, phone admin (see LauncherService). */
    private void startApi() {
        Intent s = new Intent(this, LauncherService.class);
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(s); else startService(s);
        } catch (Exception e) {
            Log.w(TAG, "service start failed", e);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        // remote debugging (Chrome DevTools over adb) only while <private folder>/debug exists (AUDIT S7):
        //   adb shell touch /sdcard/tv_hub_private/debug   (then restart the app)   /   adb shell rm ...debug
        WebView.setWebContentsDebuggingEnabled(new File(LauncherService.deviceFile().getParentFile(), "debug").exists());
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        // No autofill: the pages have no forms that need it (passwords are typed on the phone), and with Google's
        // autofill service enabled WebView would report every DOM focus move to it. Tried as a fix for the arrow-key
        // jitter on the TCL TV (2026-10-21): it did NOT change the 100-190 ms frames after each focus move.
        if (Build.VERSION.SDK_INT >= 26) web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);            // window.open / target=_blank go through the URL check below
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);                            // ignore the system font-size setting
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);      // YouTube embed sees the signed-in account
        LauncherService.installCookie(this);           // app token: the local server answers only this app (AUDIT-3 S1)

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.requestFocus();
    }

    /** Waits (max ~4s, off the UI thread) until the local server answers, so a cold boot never shows an error page. */
    private void loadWhenServerReady() {
        new Thread(() -> {
            waitForServer(4000);
            ui.post(() -> { if (web != null) web.loadUrl(PAGE_URL); });
        }).start();
    }

    private static void waitForServer(long maxMs) {
        long end = System.currentTimeMillis() + maxMs;
        while (System.currentTimeMillis() < end) {
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress("127.0.0.1", LauncherService.PORT), 300);
                return;
            } catch (Exception e) {
                try { Thread.sleep(200); } catch (InterruptedException ignored) { return; }
            }
        }
    }

    private static boolean isLocal(Uri u) {
        return u != null && "http".equals(u.getScheme()) && "127.0.0.1".equals(u.getHost()) && u.getPort() == LauncherService.PORT;
    }

    // ---------------- remote keys ----------------
    private boolean onExternalPage() {
        String url = web == null ? null : web.getUrl();
        return url != null && !isLocal(Uri.parse(url));
    }

    /**
     * A local page that is not one of the interfaces (diag.html, opened from the owner section): it has no Back
     * handling of its own, so Back and Home must take the TV back to the interface (owner report 2026-10-21).
     */
    private boolean onSecondaryLocalPage() {
        String url = web == null ? null : web.getUrl();
        if (url == null || !isLocal(Uri.parse(url))) return false;
        String path = Uri.parse(url).getPath();
        return path != null && !path.equals("/") && !path.equals("/index.html") && !path.equals("/home.html") && !path.equals("/kids.html");
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            lastInput = System.currentTimeMillis();
            if ((getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) == 0) applyScreenPolicy();
        }
        if (k == KeyEvent.KEYCODE_BACK || k == KeyEvent.KEYCODE_ESCAPE) {
            if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
                if (customView != null) exitCustomView();
                else if (onExternalPage()) backFromExternalPage();
                else if (onSecondaryLocalPage()) web.loadUrl(PAGE_URL);
                else sendBackToPage();
            }
            return true;   // never finish: this is the home screen
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    public void onBackPressed() { /* handled in dispatchKeyEvent */ }

    /**
     * Back on an internet page: go to the previous different page. Entries that only differ by "#..." (sites such as
     * Google add them on their own) are skipped; when the previous page is the dashboard, it is reloaded fresh.
     */
    private void backFromExternalPage() {
        android.webkit.WebBackForwardList h = web.copyBackForwardList();
        String here = stripHash(web.getUrl());
        for (int i = h.getCurrentIndex() - 1; i >= 0; i--) {
            String url = h.getItemAtIndex(i).getUrl();
            if (isLocal(Uri.parse(url))) break;
            if (!stripHash(url).equals(here)) { web.goBackOrForward(i - h.getCurrentIndex()); return; }
        }
        web.loadUrl(PAGE_URL);
    }

    private static String stripHash(String url) {
        int i = url == null ? -1 : url.indexOf('#');
        return i < 0 ? String.valueOf(url) : url.substring(0, i);
    }

    /** keyCode cannot be set through the KeyboardEvent constructor, so it is defined on the instance. */
    private void sendBackToPage() {
        if (web == null) return;
        web.evaluateJavascript(
                "(function(){var t=document.activeElement||document.body||document;" +
                "var e=new KeyboardEvent('keydown',{key:'GoBack',code:'GoBack',bubbles:true,cancelable:true});" +
                "try{Object.defineProperty(e,'keyCode',{get:function(){return 4}});" +
                "Object.defineProperty(e,'which',{get:function(){return 4}});}catch(x){}" +
                "t.dispatchEvent(e);})()", null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Home pressed while already here: leave any internet page, else let the page return to its main screen.
        if (web == null) return;
        if (onExternalPage() || onSecondaryLocalPage()) web.loadUrl(PAGE_URL);
        else web.evaluateJavascript("window.dispatchEvent(new CustomEvent('hub:home'))", null);
    }

    // ---------------- lifecycle (onPause makes document.visibilityState "hidden") ----------------
    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) { web.onResume(); web.requestFocus(); }
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        ui.removeCallbacksAndMessages(null);
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
        super.onDestroy();
    }

    private final Runnable reloadTask = () -> { if (web != null) web.loadUrl(PAGE_URL); };

    /** Only the pending reload is replaced: the screen timer on the same handler keeps running (AUDIT-2 N1). */
    private void scheduleReload() {
        ui.removeCallbacks(reloadTask);
        ui.postDelayed(reloadTask, RETRY_MS);
    }

    private void exitCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        WebChromeClient.CustomViewCallback cb = customCallback;
        customCallback = null;
        if (cb != null) cb.onCustomViewHidden();
        web.setVisibility(View.VISIBLE);
        web.requestFocus();
    }

    // ---------------- clients ----------------
    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            if (!r.isForMainFrame()) return false;          // YouTube iframe navigates freely inside its frame
            if (isLocal(r.getUrl())) return false;
            String scheme = r.getUrl().getScheme();
            boolean http = "http".equals(scheme) || "https".equals(scheme);
            if (http && "home".equals(LauncherService.modeOf(HomeActivity.this))) return false;   // family dashboard links
            Log.w(TAG, "blocked navigation: " + scheme + "://" + r.getUrl().getHost());
            return true;
        }

        @Override
        public void onPageStarted(WebView v, String url, Bitmap favicon) {
            // a fresh page has no player open: a reload during playback must not keep the screen on forever (N1)
            if (playing) setPlaying(false);
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            if (url != null && !isLocal(Uri.parse(url))) v.evaluateJavascript(SPATIAL_NAV, null);
        }

        /** An HTTP error for the page itself (not a picture or a script) is retried like a network error. */
        @Override
        public void onReceivedHttpError(WebView v, WebResourceRequest r, android.webkit.WebResourceResponse resp) {
            if (r.isForMainFrame() && isLocal(r.getUrl())) {
                Log.w(TAG, "page HTTP " + resp.getStatusCode() + " for " + r.getUrl().getPath() + ", retrying");
                scheduleReload();
            }
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError err) {
            if (r.isForMainFrame() && !onExternalPage()) {
                Log.w(TAG, "page load error " + err.getErrorCode() + ", retrying");
                scheduleReload();
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
            Log.e(TAG, "renderer gone (crash=" + d.didCrash() + "), recreating WebView");
            if (playing) setPlaying(false);
            root.removeAllViews();
            web.destroy();
            web = null;
            customView = null;
            customCallback = null;
            createWebView();
            scheduleReload();
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.i(TAG, "console: " + redact(m.message()) + " (" + redact(m.sourceId()) + ":" + m.lineNumber() + ")");
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) { request.deny(); }

        /**
         * Page messages can quote stream URLs, which carry the provider account (/live/<user>/<pass>/...,
         * ?username=&password=) and API keys (key=). They are removed before anything reaches the system log
         * (seen 2026-10-22: a CORS error printed the full channel URL, DECISIONS H-020).
         */
        private String redact(String s) {
            if (s == null) return "";
            return s.replaceAll("(/(?:live|movie|series|timeshift)/)[^/\\s'\"]+/[^/\\s'\"]+/", "$1***/***/")
                    .replaceAll("(?i)((?:username|password|key|token|api_key)=)[^&\\s'\")]+", "$1***");
        }

        /** Hides the grey "play" placeholder WebView draws over videos before they start. */
        @Override
        public Bitmap getDefaultVideoPoster() { return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888); }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) { callback.onCustomViewHidden(); return; }
            customView = view;
            customCallback = callback;
            web.setVisibility(View.GONE);
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }

        @Override
        public void onHideCustomView() { exitCustomView(); }
    }
}
