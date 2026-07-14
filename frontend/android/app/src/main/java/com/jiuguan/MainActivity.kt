package com.jiuguan

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.*
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var settingsLayout: LinearLayout
    private lateinit var webViewLayout: LinearLayout
    private lateinit var urlInput: EditText
    private lateinit var prefs: SharedPreferences
    private var progressBar: ProgressBar? = null

    companion object {
        private const val PREFS_NAME = "jiuguan_prefs"
        private const val KEY_SERVER_URL = "server_url"
        private const val DEFAULT_URL = ""
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        settingsLayout = findViewById(R.id.settingsLayout)
        webViewLayout = findViewById(R.id.webViewLayout)
        urlInput = findViewById(R.id.urlInput)
        progressBar = findViewById(R.id.progressBar)

        val btnConnect = findViewById<Button>(R.id.btnConnect)
        val btnSettings = findViewById<Button>(R.id.btnSettings)

        // 初始化 WebView
        webView = findViewById(R.id.webView)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
            setSupportZoom(true)
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = "Jiuguan-Android"
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                progressBar?.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                progressBar?.visibility = View.GONE
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                view?.loadUrl(request?.url.toString())
                return true
            }

            override fun onReceivedError(view: WebView?, errorCode: Int, description: String?, failingUrl: String?) {
                super.onReceivedError(view, errorCode, description, failingUrl)
                progressBar?.visibility = View.GONE
                showError("加载失败 ($errorCode): $description")
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar?.progress = newProgress
            }

            override fun onReceivedTitle(view: WebView?, title: String?) {
                super.onReceivedTitle(view, title)
                supportActionBar?.title = title ?: getString(R.string.app_name)
            }
        }

        // 加载已保存的 URL
        val savedUrl = prefs.getString(KEY_SERVER_URL, DEFAULT_URL) ?: DEFAULT_URL
        urlInput.setText(savedUrl)

        // 如果已有 URL，直接连接
        if (savedUrl.isNotEmpty() && savedUrl != DEFAULT_URL) {
            loadWebView(savedUrl)
        }

        // 连接按钮
        btnConnect.setOnClickListener {
            val url = urlInput.text.toString().trim()
            if (url.isEmpty()) {
                Toast.makeText(this, "请输入服务器地址", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            var finalUrl = url
            if (!finalUrl.startsWith("http://") && !finalUrl.startsWith("https://")) {
                finalUrl = "http://$finalUrl"
            }
            if (!finalUrl.endsWith("/")) finalUrl += "/"
            prefs.edit().putString(KEY_SERVER_URL, finalUrl).apply()
            loadWebView(finalUrl)
        }

        // 返回设置按钮
        btnSettings.setOnClickListener {
            showSettings()
        }

        // 处理返回键
        supportActionBar?.setDisplayHomeAsUpEnabled(false)
    }

    private fun loadWebView(url: String) {
        settingsLayout.visibility = View.GONE
        webViewLayout.visibility = View.VISIBLE
        webView.loadUrl(url)
    }

    private fun showSettings() {
        webViewLayout.visibility = View.GONE
        settingsLayout.visibility = View.VISIBLE
        urlInput.setText(prefs.getString(KEY_SERVER_URL, DEFAULT_URL))
    }

    private fun showError(message: String) {
        runOnUiThread {
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        }
    }

    // 按返回键: WebView 回退 / 返回设置页
    override fun onBackPressed() {
        if (webViewLayout.visibility == View.VISIBLE) {
            if (webView.canGoBack()) {
                webView.goBack()
            } else {
                showSettings()
            }
        } else {
            super.onBackPressed()
        }
    }
}
