package com.solanamobile.webshell

import android.content.Context
import android.content.Intent
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.net.toUri

open class WebShellViewClient(
    private val context: Context,
    private val scopeHostProvider: () -> String,
) : WebViewClient() {
    override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest,
    ): Boolean {
        val url = request.url
        val scheme = url.scheme ?: return false

        // Never intercept subframe (iframe) navigation — this breaks
        // embedded SDKs like Privy that use cross-origin iframes.
        if (!request.isForMainFrame) return false

        return when (scheme) {
            "solana-wallet" -> {
                context.startActivity(Intent(Intent.ACTION_VIEW, url))
                // The wallet protocol library uses window.blur to detect that the
                // wallet app opened.  In a WebView the blur event never fires
                // naturally, so we dispatch a synthetic one to unblock the
                // detection promise (3-second timeout in startSession.ts).
                view.evaluateJavascript("window.dispatchEvent(new Event('blur'))", null)
                true
            }

            "intent" -> {
                handleIntentScheme(url.toString())
                true
            }

            "blob", "javascript" -> {
                false
            }

            "http", "https" -> {
                if (url.host == scopeHostProvider.invoke()) {
                    false
                } else {
                    context.startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                }
            }

            else -> {
                context.startActivity(Intent(Intent.ACTION_VIEW, url))
                true
            }
        }
    }

    private fun handleIntentScheme(url: String) {
        try {
            val intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
            if (intent.resolveActivity(context.packageManager) != null) {
                context.startActivity(intent)
            } else {
                val fallback = intent.getStringExtra("browser_fallback_url")
                if (fallback != null) {
                    context.startActivity(Intent(Intent.ACTION_VIEW, fallback.toUri()))
                }
            }
        } catch (_: Exception) {
            // No handler available — silently ignore
        }
    }
}
