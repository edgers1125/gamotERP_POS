package com.medsource.gamoterp.posdisplay

import android.app.Activity
import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.WindowManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File

// The customer-facing second monitor (HDMI / USB-C): an android.app.Presentation on the first display in
// DISPLAY_CATEGORY_PRESENTATION, rendered with plain Android views (CustomerPresentation). JS only sends what to show
// (setConfig / showCart / showThankYou / showIdle — already formatted strings, no money maths here); the module keeps
// the last config + screen and re-renders them itself whenever a display is plugged in or the Activity comes back, so
// nothing is lost on hot-plug. With no second display every call just updates that state (a no-op on screen).
// Images (logo, ads) are cached as files under filesDir/customer_display/ (saveImage / imagePath / pruneImages), and
// the cached config JSON next to them — not secret, so plain files.

private const val TAG = "PosDisplay"
private const val DIR_NAME = "customer_display"
private const val CONFIG_FILE = "config.json"
private val SAFE_NAME = Regex("^[A-Za-z0-9._-]{1,120}$")

internal class InvalidImageNameException(name: String) : CodedException("Invalid image file name: $name")
internal class InvalidImageDataException : CodedException("The image data is not valid base64")

class PosDisplayModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var displayManager: DisplayManager? = null
  private var presentation: CustomerPresentation? = null
  private var activityVisible = true

  // Last state from JS — only touched on the main thread.
  private var config: DisplayConfig = DisplayConfig.DEFAULT
  private var screen: DisplayScreen = DisplayScreen.Idle

  private val displayListener = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(displayId: Int) = onDisplaysChanged()
    override fun onDisplayRemoved(displayId: Int) = onDisplaysChanged()
    override fun onDisplayChanged(displayId: Int) = Unit
  }

  override fun definition() = ModuleDefinition {
    Name("PosDisplay")

    // { available: boolean } — a presentation display was connected or disconnected (JS re-sends its state; the
    // module has already re-rendered the last one).
    Events("onDisplayChange")

    OnCreate {
      val context = appContext.reactContext?.applicationContext
      val dm = context?.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
      displayManager = dm
      dm?.registerDisplayListener(displayListener, main)
      main.post { updatePresentation() }
    }

    OnDestroy {
      displayManager?.unregisterDisplayListener(displayListener)
      main.post { dismissPresentation() }
    }

    OnActivityEntersForeground {
      main.post {
        activityVisible = true
        updatePresentation()
      }
    }

    // A Presentation belongs to its Activity's window: take it down while the app is in the background and put it
    // back (with the last state) when the app returns.
    OnActivityEntersBackground {
      main.post {
        activityVisible = false
        dismissPresentation()
      }
    }

    OnActivityDestroys {
      main.post { dismissPresentation() }
    }

    Function("isAvailable") {
      return@Function presentationDisplay() != null
    }

    Function("setConfig") { json: String ->
      val parsed = DisplayConfig.parse(json)
      main.post {
        config = parsed
        val p = presentation
        if (p == null) {
          updatePresentation()
        } else {
          p.setConfig(parsed)
          p.render(screen)
        }
      }
      Unit
    }

    Function("showCart") { json: String ->
      val state = JSONObject(json)
      main.post { show(DisplayScreen.Cart(state)) }
      Unit
    }

    Function("showThankYou") { json: String ->
      val state = JSONObject(json)
      main.post { show(DisplayScreen.ThankYou(state)) }
      Unit
    }

    Function("showIdle") {
      main.post { show(DisplayScreen.Idle) }
      Unit
    }

    // Writes base64 image bytes to filesDir/customer_display/<name>; returns the absolute path.
    AsyncFunction("saveImage") { name: String, base64: String ->
      if (!SAFE_NAME.matches(name) || name == CONFIG_FILE) throw InvalidImageNameException(name)
      val bytes = try {
        Base64.decode(base64, Base64.DEFAULT)
      } catch (e: IllegalArgumentException) {
        throw InvalidImageDataException()
      }
      val dir = cacheDir()
      val tmp = File(dir, "$name.tmp")
      tmp.writeBytes(bytes)
      val target = File(dir, name)
      if (target.exists()) target.delete()
      if (!tmp.renameTo(target)) {
        tmp.copyTo(target, overwrite = true)
        tmp.delete()
      }
      return@AsyncFunction target.absolutePath
    }

    // The absolute path of a cached image, or null when it isn't there.
    AsyncFunction("imagePath") { name: String ->
      if (!SAFE_NAME.matches(name)) return@AsyncFunction null
      val f = File(cacheDir(), name)
      return@AsyncFunction if (f.isFile && f.length() > 0) f.absolutePath else null
    }

    // Deletes every cached image not named in `keep` (the config file is always kept).
    AsyncFunction("pruneImages") { keep: List<String> ->
      val keepSet = keep.toSet() + CONFIG_FILE
      cacheDir().listFiles()?.forEach { f -> if (f.name !in keepSet) f.delete() }
      Unit
    }

    AsyncFunction("readConfigCache") {
      val f = File(cacheDir(), CONFIG_FILE)
      return@AsyncFunction if (f.isFile) f.readText() else null
    }

    AsyncFunction("writeConfigCache") { json: String ->
      val dir = cacheDir()
      val tmp = File(dir, "$CONFIG_FILE.tmp")
      tmp.writeText(json)
      val target = File(dir, CONFIG_FILE)
      if (target.exists()) target.delete()
      if (!tmp.renameTo(target)) {
        tmp.copyTo(target, overwrite = true)
        tmp.delete()
      }
      Unit
    }
  }

  private fun cacheDir(): File {
    val context = appContext.reactContext ?: throw IllegalStateException("No React context")
    return File(context.filesDir, DIR_NAME).apply { mkdirs() }
  }

  private fun presentationDisplay(): Display? {
    val dm = displayManager ?: return null
    return dm.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION)
      .firstOrNull { it.displayId != Display.DEFAULT_DISPLAY && it.isValid }
  }

  private fun onDisplaysChanged() {
    // Registered with the main-thread handler, so this already runs on the main thread.
    updatePresentation()
    sendEvent("onDisplayChange", mapOf("available" to (presentationDisplay() != null)))
  }

  private fun show(next: DisplayScreen) {
    screen = next
    val p = presentation
    if (p == null) updatePresentation() else p.render(next)
  }

  /** Shows the Presentation on the current presentation display (or takes it down when there is none). Main thread. */
  private fun updatePresentation() {
    val display = presentationDisplay()
    val current = presentation
    if (current != null && (display == null || current.display.displayId != display.displayId || !current.isShowing)) {
      dismissPresentation()
    }
    if (display == null || !activityVisible || presentation != null) return
    val activity: Activity = appContext.currentActivity ?: return
    if (activity.isFinishing || activity.isDestroyed) return
    try {
      val p = CustomerPresentation(activity, display)
      p.setOnDismissListener { if (presentation === p) presentation = null }
      p.setConfig(config)
      p.show()
      p.render(screen)
      presentation = p
    } catch (e: WindowManager.InvalidDisplayException) {
      Log.w(TAG, "The customer display went away while opening it", e)
      presentation = null
    } catch (e: Exception) {
      Log.w(TAG, "Could not open the customer display", e)
      presentation = null
    }
  }

  private fun dismissPresentation() {
    val p = presentation ?: return
    presentation = null
    try {
      p.release()
      p.dismiss()
    } catch (e: Exception) {
      Log.w(TAG, "Could not close the customer display", e)
    }
  }
}

internal sealed class DisplayScreen {
  object Idle : DisplayScreen()
  class Cart(val state: JSONObject) : DisplayScreen()
  class ThankYou(val state: JSONObject) : DisplayScreen()
}

internal data class DisplayAd(val path: String, val durationSeconds: Int)

/** Brand + ads + the app's neutral palette (sent from src/ui/theme.ts so the colours have one source). */
internal data class DisplayConfig(
  val brandName: String,
  val primaryColor: String,
  val secondaryColor: String,
  val logoPath: String?,
  val ads: List<DisplayAd>,
  val palette: Map<String, String>,
) {
  companion object {
    val DEFAULT = DisplayConfig("", "#445C44", "#527354", null, emptyList(), emptyMap())

    fun parse(json: String): DisplayConfig {
      val o = JSONObject(json)
      val ads = mutableListOf<DisplayAd>()
      val arr = o.optJSONArray("ads")
      if (arr != null) {
        for (i in 0 until arr.length()) {
          val a = arr.optJSONObject(i) ?: continue
          val path = a.optString("path", "")
          if (path.isNotEmpty()) ads.add(DisplayAd(path, a.optInt("durationSeconds", 10).coerceIn(1, 3600)))
        }
      }
      val palette = mutableMapOf<String, String>()
      o.optJSONObject("palette")?.let { p -> p.keys().forEach { k -> palette[k] = p.optString(k) } }
      return DisplayConfig(
        brandName = o.optString("brandName", ""),
        primaryColor = o.optString("primaryColor", DEFAULT.primaryColor),
        secondaryColor = o.optString("secondaryColor", DEFAULT.secondaryColor),
        logoPath = if (o.isNull("logoPath")) null else o.optString("logoPath").ifEmpty { null },
        ads = ads,
        palette = palette,
      )
    }
  }
}
