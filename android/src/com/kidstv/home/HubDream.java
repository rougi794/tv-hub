package com.kidstv.home;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.service.dreams.DreamService;
import android.util.Log;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import static com.kidstv.home.HomeActivity.TAG;

/**
 * TV Hub screensaver (Android "dream"), replacing Google's photo screensaver.
 * Shows saver.html from the app's local server: home = clock, dates and prayer times; kids = clock and the photo
 * of the day. No apps, no remote control: any key ends it (non-interactive dream).
 * Selected as the system screensaver with: settings put secure screensaver_components com.kidstv.home/.HubDream
 */
public class HubDream extends DreamService {
    private static final String URL = "http://127.0.0.1:8765/saver.html?dream=1";
    // shown when the local server does not answer (service not running): a plain clock, nothing to load
    private static final String FALLBACK = "<!doctype html><meta charset=utf-8><body style='margin:0;background:#000;color:#9aa4b2;"
            + "font:bold 140px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh'><div id=t></div>"
            + "<script>function f(){var d=new Date();t.textContent=('0'+(d.getHours()%12||12)).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)}f();setInterval(f,10000)</script>";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web;
    private int failures;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    public void onAttachedToWindow() {
        super.onAttachedToWindow();
        setInteractive(false);
        setFullscreen(true);
        setScreenBright(false);                                  // dimmed: kinder to the panel and the room
        // On TVs the dream's own dimming often does nothing: the window asks for a low backlight as well, and the
        // page itself is drawn darker (saver.css, .dream). Owner request 2026-10-23: dim during the screensaver.
        android.view.WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.screenBrightness = 0.2f;
        getWindow().setAttributes(lp);
        // The page comes from LauncherService, which the home screen keeps running. The dream does not start it:
        // a startForegroundService() from here crashed the app when the dream ended (H-019). If the server does
        // not answer, a plain clock is shown (FALLBACK) and the page is retried every minute.
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings st = web.getSettings();
        st.setJavaScriptEnabled(true);
        st.setDomStorageEnabled(true);                           // shares the kids photo pick and prayer cache
        st.setMediaPlaybackRequiresUserGesture(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return true; }   // stays on the saver

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError err) {
                if (!r.isForMainFrame()) return;
                failures++;
                if (failures >= 3) {
                    v.loadDataWithBaseURL(null, FALLBACK, "text/html", "utf-8", null);
                    handler.postDelayed(() -> { if (web != null) { failures = 0; web.loadUrl(URL); } }, 60_000);
                } else {
                    handler.postDelayed(() -> { if (web != null) web.loadUrl(URL); }, 2000);
                }
            }
        });
        setContentView(web);
        LauncherService.installCookie(this);                     // app token for the local server (AUDIT-3 S1)
        web.loadUrl(URL);
        Log.i(TAG, "screensaver started");
    }

    @Override
    public void onDetachedFromWindow() {
        handler.removeCallbacksAndMessages(null);
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        super.onDetachedFromWindow();
    }
}
