package com.dkasu.shiftapp;

import android.os.Build;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Executor;

@CapacitorPlugin(name = "BiometricUnlock")
public class BiometricUnlockPlugin extends Plugin {
    private int allowedAuthenticators() {
        int authenticators = BiometricManager.Authenticators.BIOMETRIC_WEAK;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            authenticators |= BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        }
        return authenticators;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int result = BiometricManager.from(getContext()).canAuthenticate(allowedAuthenticators());
        JSObject response = new JSObject();
        response.put("isAvailable", result == BiometricManager.BIOMETRIC_SUCCESS);
        response.put("deviceCredentialFallback", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R);
        call.resolve(response);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        Executor executor = ContextCompat.getMainExecutor(getContext());
        BiometricPrompt.AuthenticationCallback callback = new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                call.resolve(new JSObject());
            }

            @Override
            public void onAuthenticationError(int errorCode, CharSequence errString) {
                call.reject(errString == null ? "Unlock was canceled." : errString.toString());
            }
        };

        BiometricPrompt prompt = new BiometricPrompt(getActivity(), executor, callback);
        BiometricPrompt.PromptInfo.Builder promptBuilder = new BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock DKASU Shift")
            .setSubtitle("Verify to open your worker dashboard")
            .setAllowedAuthenticators(allowedAuthenticators());

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            promptBuilder.setNegativeButtonText("Use app PIN");
        }

        prompt.authenticate(promptBuilder.build());
    }
}
