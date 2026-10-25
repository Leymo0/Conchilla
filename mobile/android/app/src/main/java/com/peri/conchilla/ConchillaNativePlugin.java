package com.peri.conchilla;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Small Android helpers for the Conchilla pages (see mobile/mobile.js)
@CapacitorPlugin(name = "ConchillaNative")
public class ConchillaNativePlugin extends Plugin {

    // Fullscreen: hide the status and navigation bars (swipe from the edge brings them back for a moment)
    @PluginMethod
    public void setImmersive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(a.getWindow(), a.getWindow().getDecorView());
            if (on) {
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsetsCompat.Type.systemBars());
            } else {
                c.show(WindowInsetsCompat.Type.systemBars());
            }
            call.resolve();
        });
    }

    // Keep the screen on while watching / in a room
    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    // "landscape" (either way round) or "any" (follow the phone)
    @PluginMethod
    public void setOrientation(PluginCall call) {
        String mode = call.getString("mode", "any");
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            a.setRequestedOrientation("landscape".equals(mode)
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            call.resolve();
        });
    }

    // Open a GitHub link (update download) in the phone's browser
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !url.startsWith("https://github.com/Leymo0/")) {
            call.reject("not allowed");
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve(new JSObject());
    }

    // In a room: keep the connection alive in the background (ongoing notification).
    // {on, title, text}; call again with new text to update the notification.
    @PluginMethod
    public void roomService(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity a = getActivity();
        if (on) {
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(a, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !asked) {
                asked = true;
                ActivityCompat.requestPermissions(a, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 71);
            }
            try {
                RoomService.update(getContext(), call.getString("title", "In a Conchilla room"), call.getString("text", "Staying connected"));
            } catch (Exception e) {
                call.reject("couldn't start: " + e.getMessage());
                return;
            }
            MainActivity.keepRunning = true;
        } else {
            MainActivity.keepRunning = false;
            RoomService.stop(getContext());
        }
        call.resolve();
    }

    private static boolean asked = false;
}
