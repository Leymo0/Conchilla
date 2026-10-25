package com.peri.conchilla;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // true while in a room: the page keeps running in the background (see RoomService)
    static volatile boolean keepRunning = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ConchillaNativePlugin.class);
        super.onCreate(savedInstanceState);
        // the stream starts by itself when the host goes live (no tap needed for sound)
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // In a room: don't let the page freeze, or the host drops us after a few seconds
        if (keepRunning && getBridge() != null) {
            WebView w = getBridge().getWebView();
            if (w != null) { w.onResume(); w.resumeTimers(); }
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        if (keepRunning && getBridge() != null) {
            WebView w = getBridge().getWebView();
            if (w != null) { w.onResume(); w.resumeTimers(); }
        }
    }

    @Override
    public void onDestroy() {
        keepRunning = false;
        RoomService.stop(this);
        super.onDestroy();
    }
}
